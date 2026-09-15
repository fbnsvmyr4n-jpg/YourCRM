import { withSystem, withTenant, type TenantContext, type TenantQuery } from "../tenant";
import { resolveSlug, type PublicLink } from "../repos/booking-links";
import { createMeeting } from "../repos/meetings";
import { linkContactByName } from "../link-contact";
import { availabilityFor } from "./availability";
import { isOffered } from "./slots";
import { drain, queueJob } from "../outbox";
import { BOOKING_EMAIL, bookingEmailKey, OUTBOX_REGISTRY } from "../outbox-handlers";
import { logWrite } from "../log";

/**
 * A stranger writing to the database.
 *
 * Everything else in this product is a request from somebody who signed in.
 * This one is not, so each step assumes the request is hostile until it has
 * been made harmless:
 *
 *   1. The slug is resolved through the ONE unscoped read, which refuses
 *      anything not published. From here on there is a tenant, and every
 *      further statement is scoped to it.
 *   2. The posted time is not believed. Availability is regenerated from the
 *      workspace's own hours, holidays and diary, and the instant must appear
 *      in it. A page left open for an hour, or a value edited in the browser,
 *      fails here.
 *   3. The check and the write happen under a lock on the slot, so two people
 *      pressing Book at the same moment cannot both pass step 2. Without it the
 *      check is a check-then-act race and the second booking silently overwrites
 *      the first person's morning.
 *
 * Rate limiting happens above this, in the route, because it needs the caller's
 * address and should refuse before any of this runs.
 */

export type BookingRequest = {
  slug: string;
  name: string;
  email: string;
  /** ISO instant, exactly as offered. */
  startsAt: string;
  notes?: string | null;
};

export type BookingOutcome =
  | { ok: true; meetingId: string; startsAt: string; workspaceName: string }
  | { ok: false; reason: "not_found" | "taken" | "invalid"; detail: string };

/** Bounds applied before anything reaches the database. */
const MAX_NAME = 80;
const MAX_EMAIL = 160;
const MAX_NOTES = 2000;

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** Deliberately permissive but bounded: this rejects shapes, not domains. */
function validEmail(value: unknown): string | null {
  const text = clean(value, MAX_EMAIL).toLowerCase();
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(text) ? text : null;
}

/**
 * A stable 64-bit key for one workspace's one slot, for the advisory lock.
 *
 * Postgres advisory locks take numbers, so the pair has to be hashed to one.
 * `hashtext` is Postgres's own, which keeps the hashing on the side that does
 * the locking rather than depending on two languages agreeing.
 */
async function lockSlot(q: TenantQuery, subAccountId: string, startsAt: string): Promise<void> {
  await q.rows(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`book:${subAccountId}:${startsAt}`]);
}

export async function book(request: BookingRequest, now: Date = new Date()): Promise<BookingOutcome> {
  const name = clean(request.name, MAX_NAME);
  const email = validEmail(request.email);
  const notes = clean(request.notes, MAX_NOTES);
  const startsAt = typeof request.startsAt === "string" ? request.startsAt.trim() : "";

  if (!name) return { ok: false, reason: "invalid", detail: "Please give your name." };
  if (!email) return { ok: false, reason: "invalid", detail: "Please give a valid email address." };
  if (Number.isNaN(Date.parse(startsAt))) {
    return { ok: false, reason: "invalid", detail: "Please choose a time." };
  }

  /* The one unscoped read. Everything after this is inside the tenant it
     returns — and a link that is not published does not resolve, so an
     unpublished page and a nonexistent one are the same answer from outside. */
  const link: PublicLink | null = await withSystem((sys) => resolveSlug(sys, request.slug));
  if (!link) {
    return { ok: false, reason: "not_found", detail: "That booking page is not available." };
  }

  const ctx: TenantContext = {
    agencyId: link.agencyId,
    subAccountId: link.subAccountId,
    // A real person in the workspace, so the meeting and the contact have an
    // owner. See `PublicLink.ownerUserId`.
    userId: link.ownerUserId,
    role: "owner",
  };

  const result: BookingOutcome = await withTenant(ctx, async (q) => {
    /* Taken BEFORE availability is read, and held to the end of the
       transaction. Checking first and locking second would leave exactly the
       window this exists to close. */
    await lockSlot(q, link.subAccountId, startsAt);

    const availability = await availabilityFor(q, {
      days: link.daysAhead,
      slotMinutes: link.slotMinutes,
      minNoticeMinutes: link.noticeMinutes,
      now,
    });

    if (!availability.ok) {
      return {
        ok: false as const,
        reason: "not_found" as const,
        detail: "That booking page is not taking appointments at the moment.",
      };
    }

    /* The posted time is checked against what this workspace is offering RIGHT
       NOW, not against what it was offering when the page was rendered. */
    if (!isOffered(availability, startsAt)) {
      return {
        ok: false as const,
        reason: "taken" as const,
        detail: "Sorry — that time has just been taken. Please choose another.",
      };
    }

    const contactId = await linkContactByName(q, name, email);

    const meeting = await createMeeting(q, {
      topic: link.title || "Booking",
      scheduledAt: startsAt,
      durationMin: link.slotMinutes,
      kind: link.kind,
      contactId,
      ownerUserId: link.ownerUserId,
      /* Marked as coming from outside. A meeting nobody in the office arranged
         should say so on the record, or the first question when it appears in
         the diary is "who booked this". */
      notes: notes ? `Booked online.\n\n${notes}` : "Booked online.",
    });

    await queueJob(q, OUTBOX_REGISTRY, {
      handler: BOOKING_EMAIL,
      payload: { meetingId: meeting.id },
      dedupeKey: bookingEmailKey(meeting.id),
    });

    /* No email address, no name, no note — a log line is not the place for a
       stranger's details. The meeting id is enough to find the rest. */
    logWrite("create", "booking", { id: meeting.id, actor: "public" });

    return {
      ok: true as const,
      meetingId: meeting.id,
      startsAt: meeting.scheduledAt,
      workspaceName: link.workspaceName,
    };
  });

  /*
     Drained here, AFTER the booking has committed, and never inside it.

     The first version queued the confirmation and stopped, and nothing else
     would have sent it: there is no cron on this deployment, so every other
     feature that queues work drains straight afterwards. On production the
     visitor would have been told "a confirmation will be emailed" and received
     nothing, ever.

     Outside the transaction because a job's handler runs in transactions of
     its own; draining inside this one would read a meeting that has not been
     committed yet. And a failure here is swallowed, because the booking has
     already happened — a slow mail provider must not turn "you are booked"
     into an error for somebody who is booked.
  */
  if (result.ok) await drain(ctx, OUTBOX_REGISTRY, 5).catch(() => {});
  return result;
}
