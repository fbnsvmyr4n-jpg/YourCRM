"use server";

import { revalidateApp } from "@/server/revalidate";
import { CALL_OUTCOMES, type CallOutcome } from "@/data/calls";
import { deleteCall, logCall } from "@/server/repos/calls";
import { getSettings } from "@/server/repos/settings";
import { processCall } from "@/server/process-call";
import { withCurrentTenant } from "@/server/tenant-session";
import { wallClockToInstant } from "@/lib/zoned";
import { count, id as validId, multiline, pick, text } from "@/server/validate";
import { logWrite } from "@/server/log";

/**
 * Voice agent actions.
 *
 * The automation — a call becomes a contact, an opportunity, and a meeting
 * when one was asked for — lives in `process-call.ts`, above the repositories.
 * It used to run inside the calls repository, where *reading* a call created a
 * lead and a meeting as a side effect.
 *
 * A requested slot is resolved to a real instant here, at capture. The old
 * model stored "Tomorrow" and "10:00 AM" as strings, which were only true on
 * the day they were written: a call logged on Monday asking for tomorrow still
 * said tomorrow on Friday, and would have booked the meeting four days late.
 */

/** Turn a relative request into a real instant in the business's own zone. */
function resolveRequested(
  when: string | null,
  time: string,
  timeZone: string,
  now = new Date()
): string | null {
  if (!when) return null;
  const day = new Date(now);
  if (when === "Tomorrow") day.setUTCDate(day.getUTCDate() + 1);
  // "This Week" means a couple of days out — far enough not to collide with
  // tomorrow's slot, near enough to be what the caller expected.
  if (when === "This Week") day.setUTCDate(day.getUTCDate() + 2);
  return wallClockToInstant(day.toISOString().slice(0, 10), time, timeZone);
}

/** Run the automation: call → contact + deal (+ meeting when one was requested). */
export async function processCallAction(id: string) {
  return withCurrentTenant(async (q) => {
    const callId = validId(id);
    if (!callId) return { error: "Call not found." };

    const result = await processCall(q, callId);
    revalidateApp();
    return result;
  });
}

export async function deleteCallAction(id: string) {
  return withCurrentTenant(async (q) => {
    const callId = validId(id);
    if (!callId) return;
    // Soft, so a call deleted by mistake is recoverable. The records it already
    // produced are untouched either way — they are theirs now, not the call's.
    await deleteCall(q, callId);
    logWrite("delete", "call", { id: callId, actor: q.ctx.userId });
    revalidateApp();
  });
}

/** Log a call captured by the agent (used by the manual form). */
export async function logCallAction(formData: FormData) {
  return withCurrentTenant(async (q) => {
    const callerName = text(formData.get("callerName"), 80);
    // The outcome decides whether the automation creates an opportunity and
    // books a meeting, so an unrecognised value rejects the whole submission
    // rather than quietly falling back to something else.
    const outcome = pick(formData.get("outcome"), CALL_OUTCOMES);
    const durationSec = count(formData.get("durationSec"), 24 * 60 * 60);

    if (!callerName || !outcome || durationSec === null) return null;

    const { timeZone } = await getSettings(q);
    const wantsMeeting = outcome === "meeting-booked";
    const requestedAt = wantsMeeting
      ? resolveRequested(
          text(formData.get("when"), 20) || "Tomorrow",
          text(formData.get("time"), 20) || "10:00 AM",
          timeZone
        )
      : null;

    const call = await logCall(q, {
      callerName,
      phone: text(formData.get("phone"), 40),
      durationSec: durationSec || 120,
      outcome,
      summary: multiline(formData.get("summary"), 2000),
      transcript: [],
      topic: text(formData.get("topic"), 120) || null,
      requestedAt,
    });

    revalidateApp();
    return call;
  });
}

/* ------------------------------------------------------------------ */
/* Simulated inbound call                                              */
/*                                                                     */
/* Stands in for the telephony provider until one is connected. A real  */
/* provider webhook calls `logCall` with the transcribed conversation — */
/* everything downstream stays identical.                               */
/* ------------------------------------------------------------------ */

type Scenario = {
  callerName: string;
  phone: string;
  durationSec: number;
  outcome: CallOutcome;
  topic: string;
  summary: string;
  transcript: { role: "caller" | "agent"; text: string }[];
  when?: string;
  time?: string;
};

const SCENARIOS: Scenario[] = [
  {
    callerName: "Nadia Rossi",
    phone: "+27 82 551 4470",
    durationSec: 214,
    outcome: "meeting-booked",
    topic: "Demo — pipeline & reporting",
    when: "Tomorrow",
    time: "10:00 AM",
    summary:
      "Design studio moving off spreadsheets. Wants to see the pipeline board and reporting. Booked a demo.",
    transcript: [
      { role: "agent", text: "Thanks for calling YourCRM — this is Aria. How can I help?" },
      { role: "caller", text: "We're still running our clients off spreadsheets. Can you help?" },
      { role: "agent", text: "That's exactly what we fix. Shall I set up a walkthrough?" },
      { role: "caller", text: "Tomorrow morning would be great." },
      { role: "agent", text: "Done — 10:00 AM tomorrow. I've popped it in the calendar." },
    ],
  },
  {
    callerName: "Owen Blake",
    phone: "+27 71 220 8834",
    durationSec: 96,
    outcome: "qualified",
    topic: "Enquiry — lead capture",
    summary:
      "Gym franchise wanting to capture leads from their website automatically. Asked for more information.",
    transcript: [
      { role: "agent", text: "Thanks for calling YourCRM — this is Aria. How can I help?" },
      { role: "caller", text: "Can it pull leads straight off our website?" },
      { role: "agent", text: "It can. I'll send over the details today." },
    ],
  },
  {
    callerName: "Sofia Mendes",
    phone: "+27 84 907 3312",
    durationSec: 305,
    outcome: "meeting-booked",
    topic: "Onboarding call — 8 seats",
    when: "This Week",
    time: "2:30 PM",
    summary:
      "Law firm ready to move ahead on 8 seats. Wants an onboarding session before signing off.",
    transcript: [
      { role: "agent", text: "Thanks for calling YourCRM — this is Aria. How can I help?" },
      { role: "caller", text: "We're ready to go ahead — eight of us. What's next?" },
      { role: "agent", text: "I'll book an onboarding session. Later this week suit you?" },
      { role: "caller", text: "Perfect, early afternoon." },
    ],
  },
];

/** Simulate an inbound call, then immediately run the automation on it. */
export async function simulateCallAction() {
  return withCurrentTenant(async (q) => {
    const scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
    const { timeZone } = await getSettings(q);

    const call = await logCall(q, {
      callerName: scenario.callerName,
      phone: scenario.phone,
      durationSec: scenario.durationSec,
      outcome: scenario.outcome,
      summary: scenario.summary,
      transcript: scenario.transcript,
      topic: scenario.topic,
      requestedAt: scenario.when
        ? resolveRequested(scenario.when, scenario.time ?? "10:00 AM", timeZone)
        : null,
    });

    const result = await processCall(q, call.id);
    revalidateApp();
    return result;
  });
}
