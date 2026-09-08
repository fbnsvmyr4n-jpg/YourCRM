import type { TenantQuery } from "../tenant";

/**
 * The hours a workspace is open, one entry per open weekday.
 *
 * This is what a booking page consults before it offers anybody a time. The
 * rule it enforces is the one that matters: **a day nobody has configured is
 * closed.** Not "open by default", not "assume nine to five" — a workspace that
 * has said nothing offers nothing, because inventing a working week and then
 * letting a client book into it is how somebody ends up driving to a site visit
 * that was never really available.
 *
 * Times are minutes from midnight, wall-clock, in `settings.time_zone`. See the
 * table comment in `schema.sql` for why both of those are true.
 */

/** 0 is Sunday — `getDay()` and Postgres `EXTRACT(DOW)` both agree. */
export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type OpenDay = {
  weekday: Weekday;
  /** Minutes from local midnight, 0–1439. */
  opensMinute: number;
  /** Minutes from local midnight, 1–1440. 1440 means midnight at the far end. */
  closesMinute: number;
};

export const MIN_MINUTE = 0;
export const MAX_MINUTE = 1440;

/**
 * A suggestion for somebody setting this up, and nothing more.
 *
 * NOT a default that gets stored, and nothing reads it when deciding whether a
 * time is bookable. It exists so the Settings form opens on a sensible week
 * instead of seven empty rows — the person still has to press Save, which is
 * what makes the stored hours theirs rather than ours.
 */
export const SUGGESTED_WEEK: OpenDay[] = [1, 2, 3, 4, 5].map((d) => ({
  weekday: d as Weekday,
  opensMinute: 8 * 60,
  closesMinute: 17 * 60,
}));

export function isWeekday(n: number): n is Weekday {
  return Number.isInteger(n) && n >= 0 && n <= 6;
}

/**
 * "08:30" → 510. Null for anything that is not a real time of day.
 *
 * Deliberately strict about the shape: a form posting "8:30am" or "0830" is a
 * caller doing something this does not support, and quietly guessing at it is
 * how a workspace ends up open at a time nobody chose.
 */
export function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) {
    // 24:00 is the one value outside the pattern that is meaningful: a day that
    // runs to midnight has to be expressible, and 23:59 is not the same thing.
    return value.trim() === "24:00" ? MAX_MINUTE : null;
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 510 → "08:30". Zero-padded, so times line up in a column. */
export function formatClock(minute: number): string {
  const m = Math.max(MIN_MINUTE, Math.min(MAX_MINUTE, Math.round(minute)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

type Row = { weekday: number; opens_minute: number; closes_minute: number };

const toOpenDay = (r: Row): OpenDay => ({
  weekday: r.weekday as Weekday,
  opensMinute: r.opens_minute,
  closesMinute: r.closes_minute,
});

/**
 * Every open day, in week order.
 *
 * An empty array means this workspace has not set its hours — which is a real
 * answer, and the one callers must handle rather than paper over.
 * `hasWorkingHours` below is how they should ask.
 */
export async function listWorkingHours(q: TenantQuery): Promise<OpenDay[]> {
  const rows = await q.rows<Row>(
    `SELECT weekday, opens_minute, closes_minute
       FROM working_hours
      WHERE sub_account_id = $1
      ORDER BY weekday`,
    [q.ctx.subAccountId]
  );
  return rows.map(toOpenDay);
}

/** Whether any hours are set at all. A booking page must refuse without them. */
export function hasWorkingHours(week: OpenDay[]): boolean {
  return week.length > 0;
}

/** The hours for one weekday, or null when that day is closed. */
export function hoursFor(week: OpenDay[], weekday: number): OpenDay | null {
  return week.find((d) => d.weekday === weekday) ?? null;
}

export type HoursProblem = { weekday: number; message: string };

/**
 * Check a whole week before any of it is written.
 *
 * Validated as a SET rather than a row at a time so a bad Tuesday cannot be
 * saved alongside a good Monday: `replaceWorkingHours` deletes before it
 * inserts, and a partial week is worse than a rejected one — it would silently
 * close the days that failed.
 */
export function validateWeek(week: OpenDay[]): HoursProblem[] {
  const problems: HoursProblem[] = [];
  const seen = new Set<number>();

  for (const day of week) {
    if (!isWeekday(day.weekday)) {
      problems.push({ weekday: day.weekday, message: "That is not a day of the week." });
      continue;
    }
    if (seen.has(day.weekday)) {
      problems.push({ weekday: day.weekday, message: `${WEEKDAYS[day.weekday]} was given twice.` });
      continue;
    }
    seen.add(day.weekday);

    const { opensMinute: opens, closesMinute: closes } = day;
    if (!Number.isInteger(opens) || opens < MIN_MINUTE || opens > MAX_MINUTE - 1) {
      problems.push({ weekday: day.weekday, message: "Opening time is not a time of day." });
      continue;
    }
    if (!Number.isInteger(closes) || closes < MIN_MINUTE + 1 || closes > MAX_MINUTE) {
      problems.push({ weekday: day.weekday, message: "Closing time is not a time of day." });
      continue;
    }
    if (closes <= opens) {
      problems.push({
        weekday: day.weekday,
        message: `${WEEKDAYS[day.weekday]} closes at or before it opens.`,
      });
    }
  }

  return problems;
}

/**
 * Replace the whole week, in one transaction.
 *
 * Whole-week rather than per-day because the form edits a week: sending seven
 * independent writes would leave a failure halfway through as a workspace that
 * is open Monday to Wednesday and closed the rest, with nobody told. Delete
 * then insert is also how a day gets CLOSED — an absent row is the only way to
 * say that, so an update-only path could never turn a day off.
 *
 * Rejects the whole set if any of it is wrong. Returns what is now stored.
 */
export async function replaceWorkingHours(q: TenantQuery, week: OpenDay[]): Promise<OpenDay[]> {
  const problems = validateWeek(week);
  if (problems.length > 0) {
    throw new Error(problems[0].message);
  }

  await q.rows(`DELETE FROM working_hours WHERE sub_account_id = $1`, [q.ctx.subAccountId]);

  for (const day of [...week].sort((a, b) => a.weekday - b.weekday)) {
    await q.rows(
      `INSERT INTO working_hours (sub_account_id, weekday, opens_minute, closes_minute)
       VALUES ($1, $2, $3, $4)`,
      [q.ctx.subAccountId, day.weekday, day.opensMinute, day.closesMinute]
    );
  }

  return listWorkingHours(q);
}
