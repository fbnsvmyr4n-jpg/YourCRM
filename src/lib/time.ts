/**
 * Meeting times, parsed once.
 *
 * Times are stored as display strings, and two formats now coexist: the older
 * fixtures use "2:30 PM" and the scheduler writes 24-hour "14:30". Two separate
 * regexes were parsing these — both assuming a meridiem — so "14:30" became
 * `14 % 12 = 2`, placing an afternoon meeting at 02:30 on the calendar and at
 * the top of a contact's timeline.
 *
 * One parser, used everywhere, so the two can't drift apart again.
 */

export type ParsedTime = { hour: number; minute: number };

export function parseTime(time: string): ParsedTime | null {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*(am|pm)?/i.exec(time ?? "");
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3]?.toLowerCase();

  if (meridiem === "pm" && hour < 12) hour += 12;
  else if (meridiem === "am" && hour === 12) hour = 0;
  // No meridiem means the string is already 24-hour — leave the hour alone.

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour > 23 || minute > 59) return null;

  return { hour, minute };
}

/** Minutes past midnight, so a day's meetings sort chronologically. */
export function minutesOfDay(time: string): number {
  const t = parseTime(time);
  return t ? t.hour * 60 + t.minute : 0;
}

/** Canonical 24-hour form — what the scheduler stores. */
export function formatTime24(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * A time as 24-hour text, whatever it was stored as.
 *
 * Used for display so the page reads consistently even while older 12-hour
 * rows are still in the store.
 */
export function toDisplayTime(time: string): string {
  const t = parseTime(time);
  return t ? formatTime24(t.hour, t.minute) : time;
}
