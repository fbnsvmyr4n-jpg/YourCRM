"use server";

import { revalidatePath } from "next/cache";
import { CALL_OUTCOMES, type CallOutcome } from "@/data/calls";
import { MEETING_WHENS } from "@/data/meetings";
import { deleteCall, logCall, processCall } from "@/server/calls-repo";
import { count, id as validId, multiline, pick, pickOr, text } from "@/server/validate";

/**
 * Refresh every surface a processed call can touch (Leads, Meetings, the
 * dashboard). Revalidating the group layout covers them all — calling
 * `revalidatePath("/")` here would navigate the user off this page.
 */
function revalidateAll() {
  revalidatePath("/(app)", "layout");
}

/** Run the automation: call → Lead (+ Meeting when one was requested). */
export async function processCallAction(id: string) {
  const callId = validId(id);
  if (!callId) return { error: "Call not found." };

  const result = await processCall(callId);
  revalidateAll();
  return result;
}

export async function deleteCallAction(id: string) {
  const callId = validId(id);
  if (!callId) return;
  await deleteCall(callId);
  revalidatePath("/voice-agents");
}

/** Log a call captured by the agent (used by the manual form). */
export async function logCallAction(formData: FormData) {
  const callerName = text(formData.get("callerName"), 80);
  // The outcome decides whether the automation creates a lead and books a
  // meeting, so an unrecognised value has to reject the whole submission
  // rather than quietly fall back to something else.
  const outcome = pick(formData.get("outcome"), CALL_OUTCOMES);
  const durationSec = count(formData.get("durationSec"), 24 * 60 * 60);

  if (!callerName || !outcome || durationSec === null) return;

  const wantsMeeting = outcome === "meeting-booked";

  const call = await logCall({
    callerName,
    phone: text(formData.get("phone"), 40),
    company: text(formData.get("company"), 80),
    durationSec: durationSec || 120,
    outcome,
    summary: multiline(formData.get("summary"), 2000),
    transcript: [],
    topic: text(formData.get("topic"), 120) || undefined,
    // A default is safe here: the field only narrows *when* the meeting lands,
    // and the form always offers a valid choice.
    requestedWhen: wantsMeeting ? pickOr(formData.get("when"), MEETING_WHENS, "Tomorrow") : undefined,
    requestedTime: wantsMeeting ? text(formData.get("time"), 20) || "10:00 AM" : undefined,
  });

  revalidatePath("/voice-agents");
  return call;
}

/* ------------------------------------------------------------------ */
/* Simulated inbound call                                              */
/*                                                                     */
/* Stands in for the telephony provider (e.g. Twilio) until one is     */
/* connected. A real provider webhook would call `logCall` with the    */
/* transcribed conversation — everything downstream stays identical.   */
/* ------------------------------------------------------------------ */

const SCENARIOS = [
  {
    callerName: "Nadia Rossi",
    phone: "+27 82 551 4470",
    company: "Rossi Interiors",
    durationSec: 214,
    outcome: "meeting-booked" as CallOutcome,
    topic: "Demo — pipeline & reporting",
    requestedWhen: "Tomorrow" as const,
    requestedTime: "10:00 AM",
    summary:
      "Design studio moving off spreadsheets. Wants to see the pipeline board and reporting. Booked a demo.",
    transcript: [
      { speaker: "Agent" as const, text: "Thanks for calling YourCRM — this is Aria. How can I help?" },
      { speaker: "Caller" as const, text: "We're still running our clients off spreadsheets. Can you help?" },
      { speaker: "Agent" as const, text: "That's exactly what we fix. Shall I set up a walkthrough with Lang?" },
      { speaker: "Caller" as const, text: "Tomorrow morning would be great." },
      { speaker: "Agent" as const, text: "Done — 10:00 AM tomorrow. I've popped it in the calendar." },
    ],
  },
  {
    callerName: "Owen Blake",
    phone: "+27 71 220 8834",
    company: "Blake Fitness",
    durationSec: 96,
    outcome: "qualified" as CallOutcome,
    topic: "Enquiry — lead capture",
    summary:
      "Gym franchise wanting to capture leads from their website automatically. Asked for more information.",
    transcript: [
      { speaker: "Agent" as const, text: "Thanks for calling YourCRM — this is Aria. How can I help?" },
      { speaker: "Caller" as const, text: "Can it pull leads straight off our website?" },
      { speaker: "Agent" as const, text: "It can. I'll have Lang send over the details today." },
    ],
  },
  {
    callerName: "Sofia Mendes",
    phone: "+27 84 907 3312",
    company: "Mendes Legal",
    durationSec: 305,
    outcome: "meeting-booked" as CallOutcome,
    topic: "Onboarding call — 8 seats",
    requestedWhen: "This Week" as const,
    requestedTime: "2:30 PM",
    summary:
      "Law firm ready to move ahead on 8 seats. Wants an onboarding session before signing off.",
    transcript: [
      { speaker: "Agent" as const, text: "Thanks for calling YourCRM — this is Aria. How can I help?" },
      { speaker: "Caller" as const, text: "We're ready to go ahead — eight of us. What's next?" },
      { speaker: "Agent" as const, text: "I'll book an onboarding session. Later this week suit you?" },
      { speaker: "Caller" as const, text: "Perfect, early afternoon." },
    ],
  },
];

/** Simulate an inbound call, then immediately run the automation on it. */
export async function simulateCallAction() {
  const scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
  const call = await logCall(scenario);
  const result = await processCall(call.id);
  revalidateAll();
  return result;
}
