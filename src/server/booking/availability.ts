import type { TenantQuery } from "../tenant";
import { holidaySet } from "../repos/holidays";
import { listOverlapping } from "../repos/meetings";
import { getSettings } from "../repos/settings";
import { listWorkingHours } from "../repos/working-hours";
import {
  addDays,
  generateSlots,
  MAX_DAYS,
  type Availability,
  type Busy,
} from "./slots";

/**
 * Availability for a real workspace: fetch, then hand it to the pure function.
 *
 * The split is the point. Every decision about what may be offered lives in
 * `slots.ts`, where it can be driven with a fixed clock and a made-up week and
 * is the same answer every time. This file only knows how to ask the database
 * the right questions — and the one that is easy to get wrong is the meetings
 * query, which must find every meeting that OVERLAPS the window rather than
 * every meeting that starts in it.
 */

export type AvailabilityOptions = {
  /** First local date to offer, `YYYY-MM-DD`. Defaults to today, in the
   *  workspace's own zone — never the server's. */
  fromDate?: string;
  days?: number;
  slotMinutes?: number;
  stepMinutes?: number;
  minNoticeMinutes?: number;
  /** Injected so a caller can ask "what would this have looked like". */
  now?: Date;
};

/* Defaults chosen to be defensible rather than clever: half an hour is the
   commonest meeting, two weeks is far enough ahead to be useful without
   offering times the business has not thought about, and two hours' notice
   stops somebody booking a site visit that starts before anyone reads it. */
export const DEFAULT_SLOT_MINUTES = 30;
export const DEFAULT_DAYS = 14;
export const DEFAULT_NOTICE_MINUTES = 120;

/** Today's date in a given zone. The server's own date is a different day for
 *  a good part of every day, which is exactly the bug this avoids. */
export function todayIn(zone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export async function availabilityFor(
  q: TenantQuery,
  options: AvailabilityOptions = {}
): Promise<Availability> {
  const now = options.now ?? new Date();
  const settings = await getSettings(q);
  const week = await listWorkingHours(q);

  /* Answered before touching the calendar. A workspace with no hours has
     nothing to offer whatever its diary says, and the caller needs to be told
     that rather than shown an empty week. */
  if (week.length === 0) {
    return {
      ok: false,
      reason: "no_hours",
      detail: "This workspace has not set its opening hours yet.",
    };
  }

  const days = Math.min(Math.max(options.days ?? DEFAULT_DAYS, 1), MAX_DAYS);
  const fromDate = options.fromDate ?? todayIn(settings.timeZone, now);

  /* The window is widened by a day at each end before the meetings are read.
     A day in a zone ahead of UTC starts before the UTC date does, and a meeting
     can run past midnight — asking for exactly the window would miss both and
     offer a slot on top of an existing appointment. Cheap, and the overlap
     predicate does the precise work. */
  const windowStart = `${addDays(fromDate, -1) ?? fromDate}T00:00:00.000Z`;
  const windowEnd = `${addDays(fromDate, days + 1) ?? fromDate}T00:00:00.000Z`;

  const meetings = await listOverlapping(q, windowStart, windowEnd);
  const busy: Busy[] = meetings.map((m) => ({
    startsAt: m.scheduledAt,
    durationMin: m.durationMin,
  }));

  return generateSlots({
    week,
    holidays: await holidaySet(q),
    busy,
    timeZone: settings.timeZone,
    fromDate,
    days,
    slotMinutes: options.slotMinutes ?? DEFAULT_SLOT_MINUTES,
    stepMinutes: options.stepMinutes,
    minNoticeMinutes: options.minNoticeMinutes ?? DEFAULT_NOTICE_MINUTES,
    now,
  });
}
