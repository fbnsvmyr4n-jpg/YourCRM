import type { Contact } from "@/data/contacts";
import { formatTime24, parseTime } from "@/lib/time";
import { listActivity, type Activity, type ActivityKind } from "./activity-repo";
import { listCalls } from "./calls-repo";
import { listDeals } from "./deals-repo";
import { listMeetings } from "./meetings-repo";
import { listMessages } from "./inbox-repo";

/**
 * Everything that has happened with a contact, newest first.
 *
 * The report asked for *all* activity, not just what was typed into a note —
 * so this merges the logged entries with the records other parts of the CRM
 * already hold: won deals, meetings booked, and calls the voice agent handled.
 *
 * **Only events with a real timestamp are included.** Open deals are still
 * absent — a deal records no creation date, so there is nothing to place one
 * on a timeline with, and inventing a position would put a plausible lie in
 * the one place the user goes to find out what really happened.
 *
 * Inbox messages *were* excluded for the same reason (they stored `time:
 * "10:31"` and `ago: "2m ago"` as literal strings). They now carry a real `at`,
 * so they are included — which is the whole point of storing the fact rather
 * than the label.
 */

export type TimelineEntry = {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  at: string;
  amount?: number;
  /** Derived entries come from another record and can't be edited or deleted. */
  source: "logged" | "deal" | "meeting" | "call" | "message";
};

const fullName = (c: Contact) => `${c.firstName} ${c.lastName}`.trim().toLowerCase();

/** Digits only, so "+27 82 123 4567" and "0821234567" compare equal. */
const digits = (s: string) => s.replace(/\D/g, "");

function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b;
}

/**
 * A meeting's date and time as an instant.
 *
 * `time` is stored for display ("2:30 PM"), so it is parsed leniently and falls
 * back to midday rather than dropping the meeting off the timeline entirely.
 */
function meetingAt(date: string, time: string): string {
  // Shared parser: this used to have its own copy that assumed a meridiem, so
  // the scheduler's 24-hour "14:30" was read as 02:30.
  const t = parseTime(time) ?? { hour: 12, minute: 0 };
  return `${date}T${formatTime24(t.hour, t.minute)}:00.000Z`;
}

/** What the profile panel needs about one contact, beyond the record itself. */
export type ContactSummary = {
  timeline: TimelineEntry[];
  /** Real money from deals actually won — never derived from a name or a guess. */
  wonValue: number;
  openValue: number;
  deals: { id: string; title: string; value: number; stage: string; won: boolean }[];
};

/**
 * Summaries for every contact in one pass.
 *
 * Called per-contact this would re-read deals, meetings and calls once for each
 * row — the page needs all of them at once so the panel can switch instantly
 * without a round trip.
 */
export async function contactSummaries(
  contacts: Contact[]
): Promise<Record<string, ContactSummary>> {
  const [activity, deals, meetings, calls, messages] = await Promise.all([
    listActivity(),
    listDeals(),
    listMeetings(),
    listCalls(),
    listMessages(),
  ]);

  const out: Record<string, ContactSummary> = {};

  for (const contact of contacts) {
    const timeline = buildTimeline(contact, activity, deals, meetings, calls, messages);
    const theirs = deals.filter((d) => sameName(d.contact, fullName(contact)));

    out[contact.id] = {
      timeline,
      wonValue: theirs.filter((d) => d.stage === "won").reduce((s, d) => s + d.value, 0),
      openValue: theirs.filter((d) => d.stage !== "won").reduce((s, d) => s + d.value, 0),
      deals: theirs.map((d) => ({
        id: d.id,
        title: d.title,
        value: d.value,
        stage: d.stage,
        won: d.stage === "won",
      })),
    };
  }

  return out;
}

export async function contactTimeline(contact: Contact): Promise<TimelineEntry[]> {
  const [activity, deals, meetings, calls, messages] = await Promise.all([
    listActivity(),
    listDeals(),
    listMeetings(),
    listCalls(),
    listMessages(),
  ]);
  return buildTimeline(contact, activity, deals, meetings, calls, messages);
}

function buildTimeline(
  contact: Contact,
  activity: Activity[],
  deals: Awaited<ReturnType<typeof listDeals>>,
  meetings: Awaited<ReturnType<typeof listMeetings>>,
  calls: Awaited<ReturnType<typeof listCalls>>,
  messages: Awaited<ReturnType<typeof listMessages>>
): TimelineEntry[] {
  const name = fullName(contact);
  const phone = digits(contact.phone);

  const entries: TimelineEntry[] = [];

  for (const a of activity.filter((x: Activity) => x.contactId === contact.id)) {
    entries.push({
      id: a.id,
      kind: a.kind,
      title: a.title,
      detail: a.detail,
      at: a.at,
      amount: a.amount,
      source: "logged",
    });
  }

  for (const d of deals) {
    // Only won deals carry a real timestamp; the rest have no date to sit on.
    if (!d.wonAt || !sameName(d.contact, name)) continue;
    entries.push({
      id: `deal-${d.id}`,
      kind: "revenue",
      title: `Deal won — ${d.title}`,
      amount: d.value,
      at: d.wonAt,
      source: "deal",
    });
  }

  for (const m of meetings) {
    if (!m.date || !sameName(m.name, name)) continue;
    entries.push({
      id: `meeting-${m.id}`,
      kind: "meeting",
      title: m.topic ? `Meeting — ${m.topic}` : "Meeting",
      detail: `${m.time} · ${m.type}`,
      at: meetingAt(m.date, m.time),
      source: "meeting",
    });
  }

  for (const msg of messages) {
    if (!msg.at || msg.trashed) continue;
    const matches =
      (contact.email && msg.email.toLowerCase() === contact.email.toLowerCase()) ||
      sameName(msg.name, name);
    if (!matches) continue;

    entries.push({
      id: `msg-${msg.id}`,
      kind: "email",
      title: `${msg.direction === "sent" ? "Sent" : "Received"} — ${msg.subject}`,
      detail: msg.preview,
      at: msg.at,
      source: "message",
    });
  }

  for (const c of calls) {
    const matches =
      sameName(c.callerName, name) || (phone.length >= 7 && digits(c.phone).endsWith(phone.slice(-9)));
    if (!matches) continue;
    entries.push({
      id: `call-${c.id}`,
      kind: "call",
      title: `Call — ${c.outcome.replace(/-/g, " ")}`,
      detail: c.summary,
      at: c.receivedAt,
      source: "call",
    });
  }

  return entries.sort((a, b) => b.at.localeCompare(a.at));
}
