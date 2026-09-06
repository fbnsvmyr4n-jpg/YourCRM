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
 * start that task on the Saturday. Saturdays and Sundays are always skipped.
 *
 * **Public holidays are passed in, never assumed.** Every function here takes an
 * optional set of `YYYY-MM-DD` days the workspace has declared closed. That is
 * the whole design: a hardcoded list would be wrong for every customer in
 * another country and wrong for this one the year a government moves a date, and
 * a wrong holiday moves somebody's work for a reason they cannot see. No set
 * means weekends only, which is exactly how this behaved before holidays
 * existed.
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

/** The days a workspace does not work. Weekends always; holidays if declared. */
export type Holidays = ReadonlySet<string> | undefined;

const isOff = (day: number, holidays: Holidays): boolean => {
  const w = weekday(day);
  return w === 0 || w === 6 || (holidays?.has(toIso(day)) ?? false);
};

/** The first working day on or after this one. */
export function nextWorkingDay(iso: string, holidays?: Holidays): string {
  let day = toDay(iso);
  /* Bounded. A holiday set that somehow covered every day would otherwise spin
     for ever inside a request; a fortnight of consecutive closure is already
     far beyond anything real, and stopping is better than hanging. */
  for (let guard = 0; guard < 400 && isOff(day, holidays); guard++) day += 1;
  return toIso(day);
}

/**
 * Add `count` WORKING days, where adding zero still lands on a working day.
 *
 * Adding zero is not a no-op on a Saturday, and that is deliberate: every
 * caller here is asking "where does work happen from this point", and the
 * answer is never the weekend.
 */
export function addWorkingDays(iso: string, count: number, holidays?: Holidays): string {
  let day = toDay(nextWorkingDay(iso, holidays));
  for (let moved = 0; moved < count; moved++) {
    day += 1;
    for (let guard = 0; guard < 400 && isOff(day, holidays); guard++) day += 1;
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
export function workingDaysBetween(startsOn: string, dueOn: string, holidays?: Holidays): number {
  let day = toDay(startsOn);
  const end = toDay(dueOn);
  if (end < day) return 1;
  let count = 0;
  while (day <= end) {
    if (!isOff(day, holidays)) count += 1;
    day += 1;
  }
  /* A span entirely inside a weekend has no working days in it, and a task of
     zero length would collapse to a point on the chart. One is the floor. */
  return Math.max(1, count);
}

/** The finish date `days` working days after a start, inclusive of the start. */
export function finishAfter(startsOn: string, workingDays: number, holidays?: Holidays): string {
  return addWorkingDays(startsOn, Math.max(1, workingDays) - 1, holidays);
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
  predecessors: { dueOn: string | null; lagDays: number }[],
  holidays?: Holidays
): string | null {
  let latest: string | null = null;
  for (const p of predecessors) {
    if (!p.dueOn) continue;
    /* One working day after it finishes, then the lag on top. Lag 0 is the
       staircase: the next task starts the following working day. */
    const candidate = addWorkingDays(p.dueOn, 1 + Math.max(0, p.lagDays), holidays);
    if (latest === null || candidate > latest) latest = candidate;
  }
  return latest;
}
