import { listCalls } from "./calls-repo";
import { listDeals } from "./deals-repo";
import { listMessages } from "./inbox-repo";
import { listLeads } from "./leads-repo";
import { listMeetings, toDateKey } from "./meetings-repo";

/**
 * The notification feed.
 *
 * Everything here is derived from records that already exist — nothing is
 * invented and nothing is filtered out by importance. The brief was explicit:
 * show the user everything that needs their attention, because a feed that
 * quietly drops items is worse than no feed, since it can't be trusted.
 *
 * Each entry carries an `href` so the bell is a way *into* the work, not just
 * a report that work exists.
 */

export type NotificationKind = "meeting" | "lead" | "message" | "call" | "deal";

export type Notification = {
  id: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  href: string;
  /** Sorts the feed. Higher is more urgent. */
  weight: number;
};

export async function listNotifications(): Promise<Notification[]> {
  const [meetings, leads, messages, calls, deals] = await Promise.all([
    listMeetings(),
    listLeads(),
    listMessages(),
    listCalls(),
    listDeals(),
  ]);

  const out: Notification[] = [];

  // Meetings happening today — the most time-critical thing on the list.
  for (const m of meetings.filter((x) => x.when === "Today")) {
    out.push({
      id: `mtg-today-${m.id}`,
      kind: "meeting",
      title: `Meeting today · ${m.time}`,
      detail: `${m.name} — ${m.topic}`,
      href: "/meetings",
      weight: 100,
    });
  }

  // Calls the agent handled but nobody has processed into CRM records yet.
  for (const c of calls.filter((x) => x.status === "pending")) {
    out.push({
      id: `call-${c.id}`,
      kind: "call",
      title: "Call needs processing",
      detail: `${c.callerName}${c.company && c.company !== "—" ? ` · ${c.company}` : ""}`,
      href: "/voice-agents",
      weight: 90,
    });
  }

  // Meetings that have already been and gone with no outcome recorded — these
  // silently distort every rate on the Meetings page until someone marks them
  // up. Strictly *past* dates: chasing an outcome for a meeting that hasn't
  // happened yet would be noise, and would double up with the entry above.
  const todayKey = toDateKey(new Date());
  for (const m of meetings) {
    const unrecorded = (m.outcome ?? "scheduled") === "scheduled";
    if (!unrecorded || !m.date || m.date >= todayKey) continue;
    out.push({
      id: `mtg-outcome-${m.id}`,
      kind: "meeting",
      title: "Outcome not recorded",
      detail: `${m.name} — mark how the meeting went`,
      href: "/meetings",
      weight: 60,
    });
  }

  for (const l of leads.filter((x) => x.status === "Follow-up Required")) {
    out.push({
      id: `lead-${l.id}`,
      kind: "lead",
      title: "Follow-up required",
      detail: `${l.name}${l.company ? ` · ${l.company}` : ""}`,
      href: "/leads",
      weight: 70,
    });
  }

  for (const m of messages.filter((x) => x.unread && !x.trashed)) {
    out.push({
      id: `msg-${m.id}`,
      kind: "message",
      title: "Unread message",
      detail: `${m.name} — ${m.subject}`,
      href: "/inbox",
      weight: 50,
    });
  }

  // Deals awaiting payment. Money owed is worth surfacing.
  for (const d of deals.filter((x) => x.stage === "negotiation")) {
    out.push({
      id: `deal-${d.id}`,
      kind: "deal",
      title: "Awaiting payment",
      detail: `${d.title} · $${d.value.toLocaleString()}`,
      href: "/deals",
      weight: 40,
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}
