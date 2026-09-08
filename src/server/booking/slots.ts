import { instantToWallClock, wallClockToInstant } from "@/lib/zoned";
import { formatClock, hoursFor, type OpenDay } from "@/server/repos/working-hours";

/**
 * When a stranger can actually book.
 *
 * A pure function over data somebody else fetched, with `now` passed in rather
 * than read. Availability is the one calculation in this product where being
 * subtly wrong sends a real person to a real address at a time nobody is there,
 * so it has to be reproducible: the same inputs must give the same answer in a
 * test, on a laptop, and on a server in another hemisphere.
 *
 * The rules, in the order they are applied:
 *
 *   1. No working hours at all → REFUSE. Not an empty list. "We are closed all
 *      week" and "nobody has told us when we are open" are different answers
 *      and a booking page must not present the second as the first.
 *   2. A holiday closes the whole day, whatever the hours say.
 *   3. A slot must fit entirely inside the opening hours.
 *   4. A slot must not overlap a meeting already in the calendar.
 *   5. A slot must be far enough ahead to be worth offering.
 *
 * TIME ZONES ARE THE HARD PART. Opening hours are wall-clock in the workspace's
 * zone; meetings are stored as instants. Comparing those two directly is how
 * bookings land an hour out, so every candidate slot is converted to an instant
 * FIRST and every comparison happens between instants.
 */

/** An instant pair. Always UTC ISO, because a slot is a moment, not a label. */
export type Slot = { startsAt: string; endsAt: string };

export type BookableDay = {
  /** Local calendar date in the workspace's zone, `YYYY-MM-DD`. */
  date: string;
  /** 0 = Sunday, matching `working_hours`. */
  weekday: number;
  slots: Slot[];
};

/** Something already in the calendar. Only the span matters here. */
export type Busy = { startsAt: string; durationMin: number };

/**
 * Why a booking page has nothing to show.
 *
 * Separated from "no slots left" deliberately. A page that says "no times
 * available" when the truth is "this business has never set its hours" sends
 * the client away and tells the owner nothing.
 */
export type Unavailable = {
  ok: false;
  reason: "no_hours" | "unknown_zone" | "bad_request";
  detail: string;
};

export type Available = { ok: true; days: BookableDay[] };
export type Availability = Available | Unavailable;

export type SlotRequest = {
  week: OpenDay[];
  /** Local dates the workspace is closed, `YYYY-MM-DD`. */
  holidays: ReadonlySet<string>;
  busy: readonly Busy[];
  timeZone: string;
  /** First local date to consider, inclusive. */
  fromDate: string;
  /** How many days forward, including `fromDate`. */
  days: number;
  /** How long the meeting being booked lasts. */
  slotMinutes: number;
  /** Gap between candidate starts. Defaults to `slotMinutes` — back to back. */
  stepMinutes?: number;
  /** How far ahead a slot must be. Zero means "any time still in the future". */
  minNoticeMinutes: number;
  now: Date;
};

export const MAX_DAYS = 90;
export const MAX_SLOT_MINUTES = 8 * 60;
const MS = 60_000;

/** `2026-09-06` → 0 (Sunday), read as a plain calendar date, not an instant. */
export function weekdayOf(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const at = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(at)) return null;
  return new Date(at).getUTCDay();
}

/**
 * Add whole days to a calendar date.
 *
 * Done in UTC on a date-only value on purpose. Adding 24 hours to a local
 * instant is wrong twice a year — the day a clock goes forward is 23 hours
 * long, and "tomorrow" would land back on today.
 */
export function addDays(date: string, days: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const at = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(at)) return null;
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A local wall-clock time → the instant it really is, or null if it is not a
 * real moment in this zone.
 *
 * The null case is the one worth having. On the morning a clock springs
 * forward, 02:30 does not exist: `wallClockToInstant` still returns something
 * plausible, and offering that slot would show a client 02:30 and put 03:30 in
 * the calendar. Round-tripping the answer back through the zone catches it —
 * if the time we get back is not the time we asked for, the time we asked for
 * never happened.
 *
 * Ambiguous times (the hour a clock goes back, which happens twice) DO survive
 * this check, and are offered once. That is the honest outcome: the time exists,
 * and picking the first of the two is a choice rather than an error.
 */
export function localToInstant(date: string, minute: number, zone: string): Date | null {
  /* Midnight at the far end of a day is "24:00" here and "00:00" tomorrow to
     everybody else, including the parser. */
  const [d, m] = minute >= 1440 ? [addDays(date, 1), minute - 1440] : [date, minute];
  if (!d) return null;

  const clock = formatClock(m);
  const iso = wallClockToInstant(d, clock, zone);
  if (!iso) return null;

  const back = instantToWallClock(iso, zone);
  if (!back || back.date !== d || back.time !== clock) return null;

  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

function overlaps(startMs: number, endMs: number, busy: readonly Busy[]): boolean {
  for (const b of busy) {
    const bStart = Date.parse(b.startsAt);
    if (Number.isNaN(bStart)) continue;
    const bEnd = bStart + Math.max(0, b.durationMin) * MS;
    /* Half-open: a meeting ending exactly when a slot starts does not block it,
       and a slot ending exactly when one starts is fine too. Without this every
       back-to-back appointment would eat the slot beside it. */
    if (startMs < bEnd && endMs > bStart) return true;
  }
  return false;
}

export function generateSlots(req: SlotRequest): Availability {
  const {
    week,
    holidays,
    busy,
    timeZone,
    fromDate,
    days,
    slotMinutes,
    minNoticeMinutes,
    now,
  } = req;
  const step = req.stepMinutes ?? slotMinutes;

  if (week.length === 0) {
    return {
      ok: false,
      reason: "no_hours",
      detail: "This workspace has not set its opening hours yet.",
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    return { ok: false, reason: "bad_request", detail: "That is not a date." };
  }
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return { ok: false, reason: "bad_request", detail: "That is not a range of days." };
  }
  if (!Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > MAX_SLOT_MINUTES) {
    return { ok: false, reason: "bad_request", detail: "That is not a meeting length." };
  }
  if (!Number.isInteger(step) || step < 5 || step > MAX_SLOT_MINUTES) {
    return { ok: false, reason: "bad_request", detail: "That is not a gap between times." };
  }
  if (!Number.isInteger(minNoticeMinutes) || minNoticeMinutes < 0) {
    return { ok: false, reason: "bad_request", detail: "That is not an amount of notice." };
  }
  if (Number.isNaN(now.getTime())) {
    return { ok: false, reason: "bad_request", detail: "That is not a moment." };
  }
  /* Probed with a real conversion rather than trusted: an unknown zone means
     every instant below would be wrong, and silently falling back to UTC is
     precisely the defect `wallClockToInstant` was written to prevent. */
  if (localToInstant(fromDate, 12 * 60, timeZone) === null) {
    return {
      ok: false,
      reason: "unknown_zone",
      detail: "This workspace's time zone is not one we recognise.",
    };
  }

  const earliest = now.getTime() + minNoticeMinutes * MS;
  const out: BookableDay[] = [];

  for (let d = 0; d < days; d++) {
    const date = addDays(fromDate, d);
    if (!date) continue;

    // A holiday closes the day whatever the hours say — that is the whole
    // reason holidays are data rather than a rule.
    if (holidays.has(date)) continue;

    const weekday = weekdayOf(date);
    if (weekday === null) continue;

    const open = hoursFor(week, weekday);
    if (!open) continue;

    const slots: Slot[] = [];
    for (let start = open.opensMinute; start + slotMinutes <= open.closesMinute; start += step) {
      const startsAt = localToInstant(date, start, timeZone);
      // Not a real local time — the hour a clock skipped. Never offered.
      if (!startsAt) continue;

      /* The slot's real length must match its nominal one. A slot straddling a
         daylight-saving change does not: an hour vanishes or repeats inside it,
         so "09:00 for 30 minutes" would be a different amount of time than it
         says. Rather than offer a time we cannot describe accurately, drop it. */
      const nominalEnd = localToInstant(date, start + slotMinutes, timeZone);
      if (!nominalEnd) continue;
      const startMs = startsAt.getTime();
      const endMs = startMs + slotMinutes * MS;
      if (nominalEnd.getTime() !== endMs) continue;

      if (startMs < earliest) continue;
      if (overlaps(startMs, endMs, busy)) continue;

      slots.push({ startsAt: startsAt.toISOString(), endsAt: new Date(endMs).toISOString() });
    }

    // Days with nothing left are omitted rather than listed empty: a booking
    // page showing six blank days is six rows of nothing to click.
    if (slots.length > 0) out.push({ date, weekday, slots });
  }

  return { ok: true, days: out };
}

/** Every slot across every day, for callers that just want the next one. */
export function flatten(a: Availability): Slot[] {
  return a.ok ? a.days.flatMap((d) => d.slots) : [];
}

/**
 * Is this exact instant one the workspace is actually offering?
 *
 * The check a booking submission has to pass. A posted time cannot be trusted
 * because the form that produced it is on somebody else's machine — the page
 * could be stale, or the value edited outright — so the answer comes from
 * regenerating availability and looking for the instant, never from believing
 * the request.
 */
export function isOffered(a: Availability, startsAt: string): boolean {
  const wanted = Date.parse(startsAt);
  if (Number.isNaN(wanted)) return false;
  return flatten(a).some((s) => Date.parse(s.startsAt) === wanted);
}
