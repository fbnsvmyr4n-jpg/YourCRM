import type { AvatarColor } from "@/components/ui/Avatar";
import type { MeetingWhen } from "./meetings";

/** Allowed values first, types derived — see the note in `data/contacts.ts`. */
export const CALL_OUTCOMES = [
  "meeting-booked",
  "qualified",
  "message-taken",
  "not-interested",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export type CallStatus = "processed" | "pending";

export type Call = {
  id: string;
  callerName: string;
  phone: string;
  company: string;
  initials: string;
  color: AvatarColor;
  /** ISO timestamp of when the call came in. */
  receivedAt: string;
  durationSec: number;
  /** What the agent concluded from the conversation. */
  outcome: CallOutcome;
  summary: string;
  transcript: { speaker: "Agent" | "Caller"; text: string }[];
  /** Populated once the automation has run. */
  status: CallStatus;
  createdLeadId?: string;
  /**
   * Whether the automation *created* the linked lead or *matched* one that
   * already existed.
   *
   * Without this the detail card could only see that a lead id was present, so
   * it claimed "Added to Leads" either way — and every repeat caller produced a
   * card asserting a lead that never appeared on the Leads page. The
   * distinction existed only in `processCall`'s return value, which is gone the
   * moment the toast fades. Absent on rows written before this field existed.
   */
  leadLink?: "created" | "matched";
  createdMeetingId?: string;
  /** Requested slot, when the caller asked for a meeting. */
  requestedWhen?: MeetingWhen;
  requestedTime?: string;
  topic?: string;
};

export const OUTCOME_META: Record<
  CallOutcome,
  { label: string; color: string; soft: string }
> = {
  "meeting-booked": { label: "Meeting Booked", color: "var(--green)", soft: "var(--green-soft)" },
  qualified: { label: "Qualified Lead", color: "var(--accent)", soft: "var(--accent-soft)" },
  "message-taken": { label: "Message Taken", color: "var(--amber)", soft: "var(--amber-soft)" },
  "not-interested": { label: "Not Interested", color: "var(--red)", soft: "var(--red-soft)" },
};

export const agentConfig = {
  name: "Aria",
  greeting:
    "Thanks for calling YourCRM — this is Aria, Lang's assistant. How can I help you today?",
  voice: "Warm · Professional",
  // No `hours` field: the agent answers whenever the provider rings the
  // webhook, so there are no office hours to fall outside of. The old value was
  // a hardcoded "Mon–Fri, 08:00–18:00" that nothing enforced.
};

/** Seed history so the console is populated on first load. */
export const calls: Call[] = [
  {
    id: "call-seed-1",
    callerName: "Marcus Reid",
    phone: "+27 82 447 1190",
    company: "Reid Logistics",
    initials: "MR",
    color: "blue",
    receivedAt: "2026-07-26T09:12:00.000Z",
    durationSec: 232,
    outcome: "meeting-booked",
    summary:
      "Enquired about pipeline automation for a 40-person sales team. Asked for a demo — booked for tomorrow.",
    transcript: [
      { speaker: "Agent", text: "Thanks for calling YourCRM — this is Aria. How can I help?" },
      { speaker: "Caller", text: "Hi, I'd like to know if you can handle a sales team of about 40." },
      { speaker: "Agent", text: "Absolutely. Would you like me to book a demo with Lang?" },
      { speaker: "Caller", text: "Yes please, tomorrow morning if possible." },
      { speaker: "Agent", text: "Booked for 11:00 AM tomorrow. You'll get a confirmation shortly." },
    ],
    status: "processed",
    requestedWhen: "Tomorrow",
    requestedTime: "11:00 AM",
    topic: "Product demo — pipeline automation",
  },
  {
    id: "call-seed-2",
    callerName: "Dana Whitfield",
    phone: "+27 71 883 5521",
    company: "Whitfield & Sons",
    initials: "DW",
    color: "purple",
    receivedAt: "2026-07-26T08:05:00.000Z",
    durationSec: 118,
    outcome: "qualified",
    summary:
      "Comparing CRMs for a property business. Wants pricing for 12 seats — asked to be emailed details.",
    transcript: [
      { speaker: "Agent", text: "Thanks for calling YourCRM — this is Aria. How can I help?" },
      { speaker: "Caller", text: "What does it cost for about 12 users?" },
      { speaker: "Agent", text: "I'll have Lang send pricing across today. What's the best email?" },
    ],
    status: "processed",
    topic: "Pricing enquiry — 12 seats",
  },
];
