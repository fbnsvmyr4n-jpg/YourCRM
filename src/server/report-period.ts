/**
 * The window a report covers, and the one before it.
 *
 * Every figure was all-time or a fixed last-six-weeks with no control, so "how
 * did July go?" could not be asked — and neither could "was that better than
 * June?", which is the question that follows it and the only one that makes a
 * number mean anything.
 *
 * Two things this is careful about, because both are where date code goes
 * wrong:
 *
 *  - **Half-open ranges.** `from <= x < to`, never `<=` at both ends. An
 *    inclusive upper bound double-counts anything landing exactly on midnight,
 *    so a deal won at 00:00:00.000 on the 1st appears in both months.
 *  - **The business's own time zone.** "July" is July where the business is.
 *    Computed in UTC on a server in another hemisphere, the first and last day
 *    of the month belong to the wrong one.
 */

export const PERIODS = [
  "this-month",
  "last-month",
  "last-30",
  "this-quarter",
  "this-year",
  "all-time",
] as const;
export type PeriodId = (typeof PERIODS)[number];

export const PERIOD_LABELS: Record<PeriodId, string> = {
  "this-month": "This month",
  "last-month": "Last month",
  "last-30": "Last 30 days",
  "this-quarter": "This quarter",
  "this-year": "This year",
  "all-time": "All time",
};

export type Period = {
  id: PeriodId;
  label: string;
  /** Inclusive. Null for all time — no lower bound at all. */
  from: Date | null;
  /** EXCLUSIVE. See the note on half-open ranges. */
  to: Date | null;
  /** The equivalent window immediately before, for comparison. */
  previous: { from: Date; to: Date } | null;
  /** What the comparison should be called on screen. */
  previousLabel: string | null;
};

export function isPeriod(value: string): value is PeriodId {
  return (PERIODS as readonly string[]).includes(value);
}

/**
 * The parts of an instant, as read in a given time zone.
 *
 * `Intl` rather than arithmetic on the offset: an offset is not constant across
 * a year, and using today's to interpret a date in July is how a report lands
 * an hour out for half the year.
 */
function partsIn(timeZone: string, at: Date): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(at).split("-").map(Number);
  return { y, m, d };
}

/**
 * Midnight on a given calendar day, in a given zone, as an instant.
 *
 * Found by correction: guess UTC midnight, ask what the wall clock reads in the
 * zone at that instant, and shift by the difference.
 *
 * The parts are read with `formatToParts` and reassembled with `Date.UTC`. The
 * obvious version — format to a string and hand it to `new Date()` — parses in
 * the MACHINE's zone, so on a server that happens to share the customer's zone
 * the offset cancels to zero and every boundary lands an offset out. That is
 * exactly what happened here, and it was invisible until a test ran in a
 * different zone from the data.
 */
function startOfDay(timeZone: string, y: number, m: number, d: number): Date {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0, 0);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(guess));

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Some engines render midnight as hour 24 with hour12 off.
  const hour = get("hour") % 24;

  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  const offset = asIfUtc - guess;

  return new Date(guess - offset);
}

const addMonths = (y: number, m: number, n: number) => {
  const total = (y * 12 + (m - 1)) + n;
  return { y: Math.floor(total / 12), m: (total % 12) + 1 };
};

/**
 * Resolve a period into instants.
 *
 * `now` and `timeZone` are arguments rather than read from the environment, so
 * every boundary can be tested without pretending it is a different date on a
 * different continent.
 */
export function resolvePeriod(
  id: PeriodId,
  timeZone: string = "UTC",
  now: Date = new Date()
): Period {
  const label = PERIOD_LABELS[id];
  const { y, m, d } = partsIn(timeZone, now);
  const day = (yy: number, mm: number, dd: number) => startOfDay(timeZone, yy, mm, dd);

  switch (id) {
    case "this-month": {
      const from = day(y, m, 1);
      const next = addMonths(y, m, 1);
      const to = day(next.y, next.m, 1);
      const prevStart = addMonths(y, m, -1);
      return {
        id, label, from, to,
        previous: { from: day(prevStart.y, prevStart.m, 1), to: from },
        previousLabel: "last month",
      };
    }

    case "last-month": {
      const start = addMonths(y, m, -1);
      const from = day(start.y, start.m, 1);
      const to = day(y, m, 1);
      const before = addMonths(y, m, -2);
      return {
        id, label, from, to,
        previous: { from: day(before.y, before.m, 1), to: from },
        previousLabel: "the month before",
      };
    }

    case "last-30": {
      // Whole days, not "30 × 24 hours ago". A window that starts mid-afternoon
      // makes today's figures depend on what time the page was opened.
      const to = day(y, m, d + 1);
      const from = day(y, m, d - 29);
      const span = to.getTime() - from.getTime();
      return {
        id, label, from, to,
        previous: { from: new Date(from.getTime() - span), to: from },
        previousLabel: "the 30 days before",
      };
    }

    case "this-quarter": {
      const startMonth = Math.floor((m - 1) / 3) * 3 + 1;
      const from = day(y, startMonth, 1);
      const next = addMonths(y, startMonth, 3);
      const prev = addMonths(y, startMonth, -3);
      return {
        id, label, from, to: day(next.y, next.m, 1),
        previous: { from: day(prev.y, prev.m, 1), to: from },
        previousLabel: "last quarter",
      };
    }

    case "this-year": {
      const from = day(y, 1, 1);
      return {
        id, label, from, to: day(y + 1, 1, 1),
        previous: { from: day(y - 1, 1, 1), to: from },
        previousLabel: "last year",
      };
    }

    case "all-time":
    default:
      // No bounds, and nothing to compare against — "all time" has no previous
      // all time, and inventing one would be a made-up number.
      return { id: "all-time", label: PERIOD_LABELS["all-time"], from: null, to: null, previous: null, previousLabel: null };
  }
}

/**
 * How a figure changed against the previous window.
 *
 * Returns null rather than a percentage when there is nothing to compare
 * against. A rise from zero is not "+100%" or "+∞" — it is a first sale, and
 * every honest way of saying that is a word rather than a number.
 */
export function changeAgainst(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}
