"use server";

import { revalidateApp } from "@/server/revalidate";
import { LOSS_REASONS } from "@/data/meetings";
import {
  createMeeting,
  deleteMeeting,
  getMeeting,
  recordOutcome,
  restoreMeeting,
  updateMeeting,
  kindFromLabel,
  OUTCOMES,
} from "@/server/repos/meetings";
import { getSettings } from "@/server/repos/settings";
import { getContact } from "@/server/repos/contacts";
import { linkContactByName } from "@/server/link-contact";
import { withCurrentTenant } from "@/server/tenant-session";
import { sendEmail } from "@/server/email";
import { instantToWallClock, wallClockToInstant } from "@/lib/zoned";
import { toDisplayTime } from "@/lib/time";
import { email as validEmail, id as validId, multiline, pick, text } from "@/server/validate";
import { logWrite } from "@/server/log";

/**
 * Meeting actions.
 *
 * Two things changed with the schema and neither is a rename.
 *
 * A meeting stores an INSTANT, not a date string and a time string. The form
 * still submits wall-clock values, because that is what a person types, so
 * they are combined using the sub-account's own time zone. Reading the
 * server's zone instead is the defect the migration rehearsal caught, where
 * the same booking landed two hours apart depending on which machine handled
 * it.
 *
 * A meeting links to a CONTACT, not to a loose name. `linkContactByName`
 * finds the person or creates them — booking a meeting with somebody makes
 * them a contact, which is better than a name string belonging to no record.
 */

const isDateKey = (v: FormDataEntryValue | null): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export async function addMeetingAction(formData: FormData) {
  return withCurrentTenant(async (q) => {
    const name = text(formData.get("name"), 80);
    const date = formData.get("date");
    const kind = kindFromLabel(formData.get("type"));
    const time = text(formData.get("time"), 20) || "09:00";

    // A bad date or format would drop the meeting out of the calendar and the
    // reports with no visible error.
    if (!name || !isDateKey(date) || !kind) return null;

    const { timeZone } = await getSettings(q);
    const at = wallClockToInstant(date, time, timeZone);
    if (!at) return null;

    const email = validEmail(formData.get("email"));
    const contactId = await linkContactByName(q, name, email);

    const created = await createMeeting(q, {
      contactId,
      topic: text(formData.get("topic"), 120),
      scheduledAt: at,
      kind,
      joinUrl: text(formData.get("link"), 500),
      ownerUserId: q.ctx.userId,
    });

    revalidateApp();
    return created.id;
  });
}

/** Record what happened. This is what every rate on the page counts. */
export async function setMeetingOutcomeAction(id: string, outcome: string, lossReason?: string) {
  return withCurrentTenant(async (q) => {
    const meetingId = validId(id);
    const value = pick(outcome, OUTCOMES);
    // An unrecognised outcome must reject: it would land in no funnel stage and
    // quietly skew every rate on the page.
    if (!meetingId || !value) return { error: "That outcome is not valid." };

    const reason = value === "lost" ? (pick(lossReason, LOSS_REASONS) ?? "Other") : undefined;
    const updated = await recordOutcome(q, meetingId, value, { lossReason: reason });
    if (!updated) return { error: "That meeting no longer exists." };

    revalidateApp();
    return { ok: true as const };
  });
}

/**
 * Tell the participant what changed.
 *
 * Reports whether a message actually went out. Saying "participants notified"
 * with no mail provider configured would be the same class of lie as the
 * phantom lead, so the UI repeats this verbatim.
 */
export type NotifyResult = { sent: boolean; to?: string; reason?: string };

async function notify(
  to: string | undefined | null,
  subject: string,
  lines: string[]
): Promise<NotifyResult> {
  if (!to) return { sent: false, reason: "No email address on file for this participant." };

  const res = await sendEmail({
    to,
    subject,
    text: lines.join("\n"),
    html: `<p>${lines.map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("<br>")}</p>`,
  });

  return { sent: res.sent, to, reason: res.reason };
}

export async function updateMeetingAction(id: string, formData: FormData) {
  return withCurrentTenant(async (q) => {
    const meetingId = validId(id);
    if (!meetingId) return { error: "Meeting not found." };

    const name = text(formData.get("name"), 80);
    const date = formData.get("date");
    const kind = kindFromLabel(formData.get("type"));
    const time = text(formData.get("time"), 20) || "09:00";
    if (!name || !isDateKey(date) || !kind) return { error: "Check the name, date and format." };

    const email = validEmail(formData.get("email"));
    if (email === null) return { error: "That email address doesn't look right." };

    const { timeZone } = await getSettings(q);
    const at = wallClockToInstant(date, time, timeZone);
    if (!at) return { error: "That date and time could not be read." };

    const before = await getMeeting(q, meetingId);
    if (!before) return { error: "Meeting not found." };

    const contactId = await linkContactByName(q, name, email);
    const after = await updateMeeting(q, meetingId, {
      contactId,
      topic: text(formData.get("topic"), 120),
      scheduledAt: at,
      kind,
      joinUrl: text(formData.get("link"), 500),
    });
    if (!after) return { error: "Meeting not found." };

    // Only say something changed when it did — notifications for no-op edits
    // train people to ignore them.
    const wasWhen = instantToWallClock(before.scheduledAt, timeZone);
    const nowWhen = instantToWallClock(after.scheduledAt, timeZone);
    const changes: string[] = [];
    if (wasWhen?.date !== nowWhen?.date) {
      changes.push(`Date: ${wasWhen?.date ?? "—"} → ${nowWhen?.date ?? "—"}`);
    }
    if (wasWhen?.time !== nowWhen?.time) {
      changes.push(`Time: ${toDisplayTime(wasWhen?.time ?? "")} → ${toDisplayTime(nowWhen?.time ?? "")}`);
    }
    if (before.kind !== after.kind) changes.push(`Format: ${before.kind} → ${after.kind}`);
    if (before.topic !== after.topic) changes.push(`Topic: ${before.topic} → ${after.topic}`);
    if (before.joinUrl !== after.joinUrl) changes.push(`Link: ${after.joinUrl ?? "removed"}`);

    revalidateApp();

    if (changes.length === 0) {
      return { notified: { sent: false, reason: "Saved — nothing changed worth sending." } };
    }

    const contact = after.contactId ? await getContact(q, after.contactId) : null;
    const notified = await notify(contact?.email, `Updated: ${after.topic}`, [
      `Hi ${contact?.firstName ?? "there"},`,
      "",
      "Your meeting has been updated.",
      "",
      ...changes,
      "",
      "Current details:",
      `Topic: ${after.topic}`,
      `When: ${nowWhen?.date ?? "date not set"} at ${toDisplayTime(nowWhen?.time ?? "")}`,
      `Format: ${after.kind}`,
      ...(after.joinUrl ? [`Join: ${after.joinUrl}`] : []),
    ]);

    return { notified };
  });
}

export async function setMeetingNotesAction(id: string, formData: FormData) {
  return withCurrentTenant(async (q) => {
    const meetingId = validId(id);
    if (!meetingId) return;
    await updateMeeting(q, meetingId, { notes: multiline(formData.get("notes"), 5000) });
    revalidateApp();
  });
}

export async function deleteMeetingAction(id: string) {
  return withCurrentTenant(async (q) => {
    const meetingId = validId(id);
    if (!meetingId) return { notified: { sent: false, reason: "Meeting not found." } };

    // Read before deleting — afterwards there is nothing left to tell anyone
    // about, and the participant is the one person who needs to know.
    const meeting = await getMeeting(q, meetingId);
    if (!meeting) return { notified: { sent: false, reason: "Meeting not found." } };

    const contact = meeting.contactId ? await getContact(q, meeting.contactId) : null;
    const { timeZone } = await getSettings(q);
    const when = instantToWallClock(meeting.scheduledAt, timeZone);

    // Soft, so an accidental cancellation is recoverable.
    await deleteMeeting(q, meetingId);
    logWrite("delete", "meeting", { id: meetingId, actor: q.ctx.userId });
    revalidateApp();

    const notified = await notify(contact?.email, `Cancelled: ${meeting.topic}`, [
      `Hi ${contact?.firstName ?? "there"},`,
      "",
      "This meeting has been cancelled.",
      "",
      `Topic: ${meeting.topic}`,
      `Was: ${when?.date ?? "date not set"} at ${toDisplayTime(when?.time ?? "")}`,
    ]);

    return { notified };
  });
}

/** The other half of a soft delete — a cancellation undone. */
export async function restoreMeetingAction(id: string) {
  return withCurrentTenant(async (q) => {
    const meetingId = validId(id);
    if (!meetingId) return;
    if (await restoreMeeting(q, meetingId)) {
      logWrite("restore", "meeting", { id: meetingId, actor: q.ctx.userId });
    }
    revalidateApp();
  });
}
