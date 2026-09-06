/**
 * Working days, and where a dependent task lands.
 *
 * Pure functions, in their own module and touching no database, because this is
 * the arithmetic the whole cascade rests on: get it wrong and every date below
 * a moved task is wrong with it, silently and plausibly. Kept testable in
 * isolation for exactly that reason.
 *
 * **Working days, not calendar days.** Bradley's own schedule steps from Friday
 * 18 September to Monday 21 September; a cascade counting calendar days would
 * start that task on the Saturday. Saturdays and Sundays are skipped. Public
 * holidays are NOT — they vary by country and by year, and a wrong holiday list
 * is worse than none because it moves dates for a reason nobody can see. When
 * that matters it wants a real calendar per workspace, not a guess here.
 *
 * Dates are `YYYY-MM-DD` throughout and are parsed as UTC midnight, never as
 * local time — the same rule the rest of this codebase follows, and for the
 * same reason: a calendar day read in a zone behind UTC comes back a day early.
 */

const MS_PER_DAY = 86_400_000;

const toDay = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / MS_PER_DAY);
const toIso = (day: number): string => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);

/** 0 = Thursday 1 Jan 1970, so `(day + 4) % 7` gives 0 for Sunday. */
const weekday = (day: number): number => ((day + 4) % 7 + 7) % 7;

export const isWeekend = (iso: string): boolean => {
  const w = weekday(toDay(iso));
  return w === 0 || w === 6;
};

/** The first working day on or after this one. */
export function nextWorkingDay(iso: string): string {
  let day = toDay(iso);
  while (weekday(day) === 0 || weekday(day) === 6) day += 1;
  return toIso(day);
}

/**
 * Add `count` WORKING days, where adding zero still lands on a working day.
 *
 * Adding zero is not a no-op on a Saturday, and that is deliberate: every
 * caller here is asking "where does work happen from this point", and the
 * answer is never the weekend.
 */
export function addWorkingDays(iso: string, count: number): string {
  let day = toDay(nextWorkingDay(iso));
  for (let moved = 0; moved < count; moved++) {
    day += 1;
    while (weekday(day) === 0 || weekday(day) === 6) day += 1;
  }
  return toIso(day);
}

/**
 * How many working days a task occupies, counted inclusively.
 *
 * A task that starts and finishes on the same working day is one day, which is
 * what a person means by a one-day job. Weekends inside the span do not count,
 * so a task running Friday to Monday is two working days rather than four —
 * which is what makes moving it preserve the amount of WORK rather than the
 * amount of wall-clock.
 */
export function workingDaysBetween(startsOn: string, dueOn: string): number {
  let day = toDay(startsOn);
  const end = toDay(dueOn);
  if (end < day) return 1;
  let count = 0;
  while (day <= end) {
    const w = weekday(day);
    if (w !== 0 && w !== 6) count += 1;
    day += 1;
  }
  /* A span entirely inside a weekend has no working days in it, and a task of
     zero length would collapse to a point on the chart. One is the floor. */
  return Math.max(1, count);
}

/** The finish date `days` working days after a start, inclusive of the start. */
export function finishAfter(startsOn: string, workingDays: number): string {
  return addWorkingDays(startsOn, Math.max(1, workingDays) - 1);
}

/**
 * Where a task must start, given everything it waits for.
 *
 * The day after the LATEST predecessor finishes, plus that link's lag, in
 * working days. The latest one wins because a task waiting on two things waits
 * for both — taking the earliest would schedule work to begin before something
 * it depends on has finished, which is the failure this whole feature exists to
 * prevent.
 *
 * Null when nothing it waits on has a finish date yet: an unknown predecessor
 * cannot imply a date, and inventing one would put a confident bar on a chart
 * with nothing behind it.
 */
export function earliestStart(
  predecessors: { dueOn: string | null; lagDays: number }[]
): string | null {
  let latest: string | null = null;
  for (const p of predecessors) {
    if (!p.dueOn) continue;
    /* One working day after it finishes, then the lag on top. Lag 0 is the
       staircase: the next task starts the following working day. */
    const candidate = addWorkingDays(p.dueOn, 1 + Math.max(0, p.lagDays));
    if (latest === null || candidate > latest) latest = candidate;
  }
  return latest;
}
