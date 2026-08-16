"use server";

import { revalidateApp } from "@/server/revalidate";
import { LOSS_REASONS, MEETING_OUTCOMES, MEETING_TYPES } from "@/data/meetings";
import { detachMeeting } from "@/server/calls-repo";
import {
  createMeeting,
  deleteMeeting,
  getMeeting,
  setMeetingNotes,
  setMeetingOutcome,
  toDateKey,
  updateMeeting,
} from "@/server/meetings-repo";
import { sendEmail } from "@/server/email";
import { toDisplayTime } from "@/lib/time";
import { email as validEmail, id as validId, multiline, pick, text } from "@/server/validate";
import { requireUser } from "@/server/session";

/** `YYYY-MM-DD` and a real calendar date, not just well-shaped text. */
function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00`);
  return Number.isFinite(d.getTime()) && toDateKey(d) === value;
}

export async function addMeetingAction(formData: FormData) {
  await requireUser();
  const name = text(formData.get("name"), 80);
  const date = formData.get("date");
  const type = pick(formData.get("type"), MEETING_TYPES);

  // The date is what the Today/Tomorrow label and the calendar are both derived
  // from; `type` feeds the online / in-person split on Reports. A bad value in
  // either would drop the meeting out of those views with no visible error.
  if (!name || !isDateKey(date) || !type) return;

  const created = await createMeeting({
    name,
    company: text(formData.get("company"), 80),
    topic: text(formData.get("topic"), 120),
    date,
    time: text(formData.get("time"), 20),
    type,
    link: text(formData.get("link"), 500),
    email: text(formData.get("email"), 120),
  });
  revalidateApp();
  return created.id;
}

/** Record what happened at a meeting — this is what the funnel counts. */
export async function setMeetingOutcomeAction(
  id: string,
  outcome: string,
  lossReason?: string
) {
  await requireUser();
  const meetingId = validId(id);
  const value = pick(outcome, MEETING_OUTCOMES);
  // An unrecognised outcome must reject: it would land in no funnel stage and
  // quietly skew every rate on the page.
  if (!meetingId || !value) return;

  const reason = value === "lost" ? (pick(lossReason, LOSS_REASONS) ?? "Other") : undefined;
  await setMeetingOutcome(meetingId, value, reason);
  revalidateApp();
}

/**
 * Tell the participant what changed.
 *
 * Reports whether a message actually went out. Saying "participants notified"
 * when no mail provider is configured would be the same class of lie as the
 * phantom lead — so the UI repeats this verbatim.
 */
export type NotifyResult = { sent: boolean; to?: string; reason?: string };

function describe(m: { date?: string; time: string; type: string; topic: string; link?: string }) {
  return [
    `Topic: ${m.topic}`,
    `When: ${m.date ?? "date not set"} at ${toDisplayTime(m.time)}`,
    `Format: ${m.type}`,
    m.link ? `Join: ${m.link}` : null,
  ].filter((l): l is string => l !== null);
}

async function notify(to: string | undefined, subject: string, lines: string[]): Promise<NotifyResult> {
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
  await requireUser();
  const meetingId = validId(id);
  if (!meetingId) return { error: "Meeting not found." };

  const name = text(formData.get("name"), 80);
  const date = formData.get("date");
  const type = pick(formData.get("type"), MEETING_TYPES);
  if (!name || !isDateKey(date) || !type) return { error: "Check the name, date and format." };

  const email = validEmail(formData.get("email"));
  if (email === null) return { error: "That email address doesn't look right." };

  const result = await updateMeeting(meetingId, {
    name,
    company: text(formData.get("company"), 80),
    topic: text(formData.get("topic"), 120),
    date,
    time: text(formData.get("time"), 20),
    type,
    link: text(formData.get("link"), 500),
    email,
  });

  if (!result) return { error: "Meeting not found." };
  const { before, after } = result;

  // Only say something changed when it did — notifications for no-op edits
  // train people to ignore them.
  const changes: string[] = [];
  if (before.date !== after.date) changes.push(`Date: ${before.date ?? "—"} → ${after.date ?? "—"}`);
  if (before.time !== after.time) changes.push(`Time: ${toDisplayTime(before.time)} → ${toDisplayTime(after.time)}`);
  if (before.type !== after.type) changes.push(`Format: ${before.type} → ${after.type}`);
  if (before.topic !== after.topic) changes.push(`Topic: ${before.topic} → ${after.topic}`);
  if (before.link !== after.link) changes.push(`Link: ${after.link ?? "removed"}`);

  revalidateApp();

  if (changes.length === 0) {
    return { notified: { sent: false, reason: "Saved — nothing changed worth sending." } };
  }

  const notified = await notify(after.email, `Updated: ${after.topic}`, [
    `Hi ${after.name},`,
    "",
    "Your meeting has been updated.",
    "",
    ...changes,
    "",
    "Current details:",
    ...describe(after),
  ]);

  return { notified };
}

export async function setMeetingNotesAction(id: string, formData: FormData) {
  await requireUser();
  const meetingId = validId(id);
  if (!meetingId) return;
  await setMeetingNotes(meetingId, multiline(formData.get("notes"), 5000));
  revalidateApp();
}

export async function deleteMeetingAction(id: string) {
  await requireUser();
  const meetingId = validId(id);
  if (!meetingId) return { notified: { sent: false, reason: "Meeting not found." } };

  // Read before deleting — afterwards there is nothing left to tell anyone about.
  const meeting = await getMeeting(meetingId);

  await deleteMeeting(meetingId);
  // Referential integrity — see `detachMeeting`. Sequential, never nested.
  await detachMeeting(meetingId);

  revalidateApp();

  if (!meeting) return { notified: { sent: false, reason: "Meeting not found." } };

  const notified = await notify(meeting.email, `Cancelled: ${meeting.topic}`, [
    `Hi ${meeting.name},`,
    "",
    "This meeting has been cancelled:",
    "",
    ...describe(meeting),
  ]);

  return { notified };
}
