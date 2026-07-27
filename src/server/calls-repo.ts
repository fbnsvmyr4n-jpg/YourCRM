import type { AvatarColor } from "@/components/ui/Avatar";
import { calls as seed, type Call, type CallOutcome } from "@/data/calls";
import { createLead, listLeads } from "./leads-repo";
import { createMeeting, toDateKey } from "./meetings-repo";
import type { MeetingWhen } from "@/data/meetings";
import { mutateTable, readTable } from "./store";

const TABLE = "calls";

const COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

function initialsFor(name: string) {
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? "";
  const b = parts[1]?.[0] ?? "";
  return (a + b || name.trim().slice(0, 2)).toUpperCase();
}

export async function listCalls(): Promise<Call[]> {
  const rows = await readTable<Call>(TABLE, seed);
  // newest first
  return [...rows].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export type IncomingCall = {
  callerName: string;
  phone: string;
  company: string;
  durationSec: number;
  outcome: CallOutcome;
  summary: string;
  transcript: { speaker: "Agent" | "Caller"; text: string }[];
  requestedWhen?: Call["requestedWhen"];
  requestedTime?: string;
  topic?: string;
};

/** Record a call the agent handled. Does not run the automation. */
export async function logCall(input: IncomingCall): Promise<Call> {
  let call!: Call;
  await mutateTable<Call>(TABLE, seed, (rows) => {
    call = {
      id: `call-${Math.random().toString(36).slice(2, 10)}`,
      callerName: input.callerName.trim() || "Unknown Caller",
      phone: input.phone.trim() || "—",
      company: input.company.trim() || "—",
      initials: initialsFor(input.callerName || "Unknown"),
      color: COLORS[rows.length % COLORS.length],
      receivedAt: new Date().toISOString(),
      durationSec: input.durationSec,
      outcome: input.outcome,
      summary: input.summary.trim(),
      transcript: input.transcript,
      status: "pending",
      requestedWhen: input.requestedWhen,
      requestedTime: input.requestedTime,
      topic: input.topic,
    };
    return [call, ...rows];
  });
  return call;
}

/** Phone numbers are written inconsistently — compare digits only. */
function digits(value: string) {
  return value.replace(/\D/g, "");
}

/** Turn the caller's relative request into the concrete date it means today. */
function dateForRequest(when: MeetingWhen): string {
  const offset = when === "Today" ? 0 : when === "Tomorrow" ? 1 : 3;
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return toDateKey(d);
}

/**
 * Find a lead that already represents this caller, so repeat calls attach to
 * the existing record instead of creating duplicates.
 */
async function findExistingLead(phone: string, name: string, company: string) {
  const leads = await listLeads();
  const phoneKey = digits(phone);

  if (phoneKey.length >= 7) {
    const byPhone = leads.find((l) => digits(l.phone) === phoneKey);
    if (byPhone) return byPhone;
  }

  const nameKey = name.trim().toLowerCase();
  const companyKey = company.trim().toLowerCase();
  return leads.find(
    (l) => l.name.trim().toLowerCase() === nameKey && l.company.trim().toLowerCase() === companyKey
  );
}

export type ProcessResult = {
  call?: Call;
  leadCreated?: boolean;
  /** True when the caller matched an existing lead instead of creating one. */
  leadMatched?: boolean;
  meetingCreated?: boolean;
  error?: string;
};

/**
 * The automation pipeline.
 *
 * Turns a handled call into CRM records so nothing is captured by hand:
 *   • every call that isn't a dead end is attached to a **Lead** (source: Phone
 *     Call) — matching an existing lead for repeat callers rather than
 *     duplicating them
 *   • a call where the caller asked for a slot also **books a Meeting**
 *
 * Both land in the Leads and Meetings tabs immediately. Safe to call twice —
 * an already-processed call is a no-op.
 */
export async function processCall(id: string): Promise<ProcessResult> {
  const rows = await readTable<Call>(TABLE, seed);
  const idx = rows.findIndex((c) => c.id === id);
  if (idx === -1) return { error: "Call not found." };

  const call = rows[idx];
  if (call.status === "processed") return { call };

  let leadCreated = false;
  let leadMatched = false;
  let meetingCreated = false;
  let createdLeadId: string | undefined;
  let createdMeetingId: string | undefined;

  // 1. Capture the caller as a lead — unless they explicitly weren't interested.
  //    A repeat caller must not create a duplicate: match an existing lead on
  //    phone number first (the reliable identifier), then on name + company.
  if (call.outcome !== "not-interested") {
    const existing = await findExistingLead(call.phone, call.callerName, call.company);
    if (existing) {
      createdLeadId = existing.id;
      leadMatched = true; // attached to an existing lead, not duplicated
    } else {
      const lead = await createLead({
        name: call.callerName,
        email: "",
        phone: call.phone,
        location: "",
        company: call.company,
        status: "Follow-up Required",
        source: "Phone Call",
      });
      createdLeadId = lead.id;
      leadCreated = true;
    }
  }

  // 2. Book the meeting the caller asked for.
  if (call.outcome === "meeting-booked" && call.requestedWhen && call.requestedTime) {
    // The caller asked for a relative slot ("tomorrow"); meetings are stored
    // against a real date, so resolve it once here rather than keeping a label
    // that would drift out of date.
    const meeting = await createMeeting({
      name: call.callerName,
      company: call.company,
      topic: call.topic || "Call follow-up",
      date: dateForRequest(call.requestedWhen),
      time: call.requestedTime,
      type: "Online",
    });
    createdMeetingId = meeting.id;
    meetingCreated = true;
  }

  // 3. Mark the call done, linking what it produced. Done atomically so a
  //    concurrent write to another call can't clobber this update.
  //    Note: the lead/meeting writes above take their own locks and complete
  //    before this one starts — locks are never nested, so no deadlock.
  const updated: Call = { ...call, status: "processed", createdLeadId, createdMeetingId };
  await mutateTable<Call>(TABLE, seed, (rows) => {
    const at = rows.findIndex((c) => c.id === id);
    if (at === -1) return rows;
    const next = [...rows];
    next[at] = updated;
    return next;
  });

  return { call: updated, leadCreated, leadMatched, meetingCreated };
}

export async function deleteCall(id: string): Promise<void> {
  await mutateTable<Call>(TABLE, seed, (rows) => rows.filter((c) => c.id !== id));
}

/* ---------------- referential integrity ---------------- */

/**
 * A call stores the id of the lead and meeting its automation produced, and the
 * Voice Agent detail renders "Added to Leads" / "Meeting booked" from those
 * ids. Deleting the lead or meeting elsewhere would leave the call pointing at
 * a record that no longer exists, so the UI keeps asserting something untrue.
 *
 * These clear the link instead of deleting the call — the call itself is still
 * a real, valuable record of a conversation that happened.
 *
 * Call them from the delete action *after* the lead/meeting write has finished.
 * That keeps the two table locks sequential rather than nested, which is what
 * keeps the write paths deadlock-free (see the note in `processCall`).
 */
export async function detachLead(leadId: string): Promise<void> {
  await mutateTable<Call>(TABLE, seed, (rows) => {
    if (!rows.some((c) => c.createdLeadId === leadId)) return rows; // nothing to do
    return rows.map((c) =>
      c.createdLeadId === leadId ? { ...c, createdLeadId: undefined } : c
    );
  });
}

export async function detachMeeting(meetingId: string): Promise<void> {
  await mutateTable<Call>(TABLE, seed, (rows) => {
    if (!rows.some((c) => c.createdMeetingId === meetingId)) return rows;
    return rows.map((c) =>
      c.createdMeetingId === meetingId ? { ...c, createdMeetingId: undefined } : c
    );
  });
}
