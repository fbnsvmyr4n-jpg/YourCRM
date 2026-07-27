"use server";

import { revalidatePath } from "next/cache";
import { LOSS_REASONS, MEETING_OUTCOMES, MEETING_TYPES } from "@/data/meetings";
import { detachMeeting } from "@/server/calls-repo";
import { createMeeting, deleteMeeting, setMeetingOutcome, toDateKey } from "@/server/meetings-repo";
import { id as validId, pick, text } from "@/server/validate";

/** `YYYY-MM-DD` and a real calendar date, not just well-shaped text. */
function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00`);
  return Number.isFinite(d.getTime()) && toDateKey(d) === value;
}

export async function addMeetingAction(formData: FormData) {
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
  });
  revalidatePath("/meetings");
  return created.id;
}

/** Record what happened at a meeting — this is what the funnel counts. */
export async function setMeetingOutcomeAction(
  id: string,
  outcome: string,
  lossReason?: string
) {
  const meetingId = validId(id);
  const value = pick(outcome, MEETING_OUTCOMES);
  // An unrecognised outcome must reject: it would land in no funnel stage and
  // quietly skew every rate on the page.
  if (!meetingId || !value) return;

  const reason = value === "lost" ? (pick(lossReason, LOSS_REASONS) ?? "Other") : undefined;
  await setMeetingOutcome(meetingId, value, reason);
  revalidatePath("/meetings");
  revalidatePath("/reports");
}

export async function deleteMeetingAction(id: string) {
  const meetingId = validId(id);
  if (!meetingId) return;

  await deleteMeeting(meetingId);
  // Referential integrity — see `detachMeeting`. Sequential, never nested.
  await detachMeeting(meetingId);

  revalidatePath("/meetings");
  revalidatePath("/voice-agents");
}
