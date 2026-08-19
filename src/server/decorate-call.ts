import type { CallRecord } from "./repos/calls";
import type { Call, CallOutcome } from "@/data/calls";
import { CALL_OUTCOMES } from "@/data/calls";
import { instantToWallClock } from "@/lib/zoned";
import type { AvatarColor } from "@/components/ui/Avatar";

/**
 * A stored call, shaped for the console.
 *
 * `status` is derived rather than stored. It was a column that said
 * "processed" or "pending", and it could disagree with whether the call had
 * actually produced anything — a row could claim to be processed while
 * carrying no links at all. It now answers the only question that matters:
 * did this call create records?
 *
 * `leadLink` is derived the same way. Its comment in the old model explains
 * why it existed: without it the card claimed "Added to Leads" for every
 * repeat caller, asserting a lead that never appeared anywhere. It is now a
 * fact about the links rather than a flag somebody had to remember to set.
 */

const AVATAR_COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

function paletteFor(id: string): AvatarColor {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function decorateCall(
  c: CallRecord,
  people: { id: string; name: string; info: string | null }[],
  timeZone: string
): Call {
  const person = people.find((p) => p.id === c.contactId);
  const name = c.callerName || person?.name || "Unknown caller";
  const parts = name.split(/\s+/).filter(Boolean);
  const requested = c.requestedAt ? instantToWallClock(c.requestedAt, timeZone) : null;

  return {
    id: c.id,
    callerName: name,
    phone: c.phone ?? "",
    company: person?.info ?? "",
    initials: ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?",
    color: paletteFor(c.id),
    receivedAt: c.receivedAt,
    durationSec: c.durationSec,
    // Confirmed against the allow-list rather than asserted: an outcome the UI
    // has no label for would render a blank chip and drop out of the counts.
    outcome: (CALL_OUTCOMES.find((o) => o === c.outcome) ?? "qualified") as CallOutcome,
    summary: c.summary ?? "",
    transcript: c.transcript.map((t) => ({
      speaker: t.role === "agent" ? ("Agent" as const) : ("Caller" as const),
      text: t.text,
    })),
    // Derived: a call has been processed when it produced something.
    status: c.createdDealId || c.createdMeetingId ? "processed" : "pending",
    createdLeadId: c.contactId ?? undefined,
    // A call that produced a deal created the opportunity; one linked only to a
    // contact recognised somebody already on file.
    leadLink: c.createdDealId ? "created" : c.contactId ? "matched" : undefined,
    createdMeetingId: c.createdMeetingId ?? undefined,
    // Shown as the real date it resolves to, not the relative word that was
    // typed — "Tomorrow" stops being true the day after it is written.
    requestedWhen: undefined,
    requestedTime: requested ? `${requested.date} ${requested.time}` : undefined,
    topic: c.topic ?? undefined,
  };
}
