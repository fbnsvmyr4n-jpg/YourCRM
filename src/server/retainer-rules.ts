/**
 * Retainers without a database: when each period starts, what it is called,
 * and what a retainer is worth a month.
 *
 * Dates are calendar days as "YYYY-MM-DD" strings, never instants — a billing
 * period is a day on the business's calendar, and turning it into a moment in
 * some time zone is how the first of the month becomes the thirty-first.
 */

export const RETAINER_EVERY = ["month", "quarter", "year"] as const;
export type RetainerEvery = (typeof RETAINER_EVERY)[number];

export const RETAINER_STATUSES = ["active", "paused", "cancelled"] as const;
export type RetainerStatus = (typeof RETAINER_STATUSES)[number];

const MONTHS_IN: Record<RetainerEvery, number> = { month: 1, quarter: 3, year: 12 };

/** The most periods one run will raise for one retainer. A retainer back-dated
 *  a decade must not put a hundred and twenty drafts on a project in one go. */
export const MAX_CATCH_UP = 12;

export type Retainer = {
  id: string;
  dealId: string;
  description: string;
  amountCents: number;
  every: RetainerEvery;
  startsOn: string;
  endsOn: string | null;
  dueDays: number;
  status: RetainerStatus;
  periodsBilled: number;
  nextInvoiceOn: string;
  createdAt: string;
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function isIsoDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const parts = (day: string) => day.split("-").map(Number) as [number, number, number];
const iso = (y: number, m0: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

/**
 * The first day of period `n` (0-based), always counted from the start date.
 *
 * A start on the 31st bills on the last day of shorter months and returns to
 * the 31st when the month has one.
 */
export function periodStart(startsOn: string, every: RetainerEvery, n: number): string {
  const [y, m, d] = parts(startsOn);
  const total = m - 1 + n * MONTHS_IN[every];
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  return iso(year, month, Math.min(d, daysInMonth(year, month)));
}

/** The last day period `n` covers: the day before the next one starts. */
export function periodEnd(startsOn: string, every: RetainerEvery, n: number): string {
  return addDays(periodStart(startsOn, every, n + 1), -1);
}

/** The first period starting on or after `today` — where a resumed retainer picks up. */
export function firstPeriodFrom(startsOn: string, every: RetainerEvery, today: string): number {
  if (today <= startsOn) return 0;
  const [y1, m1] = parts(startsOn);
  const [y2, m2] = parts(today);
  let n = Math.max(0, Math.floor(((y2 - y1) * 12 + (m2 - m1)) / MONTHS_IN[every]) - 1);
  while (periodStart(startsOn, every, n) < today) n += 1;
  return n;
}

/** Whether period `n` still falls within the retainer. */
export function withinTerm(startsOn: string, endsOn: string | null, every: RetainerEvery, n: number): boolean {
  return endsOn === null || periodStart(startsOn, every, n) <= endsOn;
}

/** "1–30 Sep 2026", "1 Sep – 30 Nov 2026", "15 Dec 2026 – 14 Dec 2027". */
export function periodLabel(start: string, end: string): string {
  const [y1, m1, d1] = parts(start);
  const [y2, m2, d2] = parts(end);
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTH_NAMES[m1 - 1]} ${y1}`;
  if (y1 === y2) return `${d1} ${MONTH_NAMES[m1 - 1]} – ${d2} ${MONTH_NAMES[m2 - 1]} ${y1}`;
  return `${d1} ${MONTH_NAMES[m1 - 1]} ${y1} – ${d2} ${MONTH_NAMES[m2 - 1]} ${y2}`;
}

/** "Sat 1 Nov 2026" is more than a list needs: "1 Nov 2026". */
export function dayLabel(day: string): string {
  const [y, m, d] = parts(day);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

export const EVERY_LABEL: Record<RetainerEvery, string> = { month: "month", quarter: "quarter", year: "year" };

/** What it brings in a month, for adding retainers of different rhythms together. */
export function monthlyCents(amountCents: number, every: RetainerEvery): number {
  return Math.round(amountCents / MONTHS_IN[every]);
}

/**
 * Which periods are due to be billed by `today`, and where the retainer stands
 * afterwards. Pure, so the database only has to write what this decides.
 */
export function duePeriods(
  r: Pick<Retainer, "startsOn" | "endsOn" | "every" | "status" | "periodsBilled">,
  today: string
): { periods: number[]; periodsBilled: number; nextInvoiceOn: string } {
  const periods: number[] = [];
  let n = r.periodsBilled;
  if (r.status === "active") {
    while (
      periods.length < MAX_CATCH_UP &&
      periodStart(r.startsOn, r.every, n) <= today &&
      withinTerm(r.startsOn, r.endsOn, r.every, n)
    ) {
      periods.push(n);
      n += 1;
    }
  }
  return { periods, periodsBilled: n, nextInvoiceOn: periodStart(r.startsOn, r.every, n) };
}
