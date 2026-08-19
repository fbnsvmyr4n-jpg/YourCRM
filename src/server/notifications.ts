import { listCalls } from "./repos/calls";
import { listDeals } from "./repos/deals";
import { listMeetings } from "./repos/meetings";
import { listContacts } from "./repos/contacts";
import { unreadCount } from "./repos/inbox";
import { getSettings } from "./repos/settings";
import { instantToWallClock } from "@/lib/zoned";
import type { TenantQuery } from "./tenant";

/**
 * The notification feed.
 *
 * Everything here is derived from records that already exist — nothing is
 * invented and nothing is filtered out by importance. The brief was explicit:
 * show the user everything that needs their attention, because a feed that
 * quietly drops items is worse than no feed, since it cannot be trusted.
 *
 * Each entry carries an `href` so the bell is a way *into* the work, not just
 * a report that work exists. And each is a state that is currently TRUE rather
 * than an event somebody once fired, which is why it needs no storage: it is a
 * question asked of the data, not a queue to keep in step.
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

export async function listNotifications(q: TenantQuery): Promise<Notification[]> {
  const settings = await getSettings(q);
  const meetings = await listMeetings(q);
  const calls = await listCalls(q);
  const deals = await listDeals(q);
  const contacts = await listContacts(q);
  const unread = await unreadCount(q);

  const nameOf = new Map(contacts.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]));
  const todayKey =
    instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
    new Date().toISOString().slice(0, 10);

  const out: Notification[] = [];

  // Meetings happening today — the most time-critical thing on the list, and
  // counted in the business's zone rather than the server's.
  for (const m of meetings) {
    const when = instantToWallClock(m.scheduledAt, settings.timeZone);
    if (when?.date !== todayKey || m.outcome !== "scheduled") continue;
    out.push({
      id: `mtg-today-${m.id}`,
      kind: "meeting",
      title: `Meeting today · ${when.time}`,
      detail: [m.contactId ? nameOf.get(m.contactId) : null, m.topic].filter(Boolean).join(" — "),
      href: "/meetings",
      weight: 100,
    });
  }

  // Calls the agent handled that have not become records yet. "Pending" is a
  // call carrying no links — derived from what happened rather than a stored
  // status that could disagree with it.
  for (const c of calls) {
    if (c.createdDealId || c.createdMeetingId) continue;
    out.push({
      id: `call-${c.id}`,
      kind: "call",
      title: "Call needs processing",
      detail: c.callerName || "Unknown caller",
      href: "/voice-agents",
      weight: 90,
    });
  }

  // Meetings that have happened and nobody has said what came of them. This is
  // the backlog that quietly makes every rate on the Meetings page unanswerable.
  const past = meetings.filter(
    (m) => m.outcome === "scheduled" && Date.parse(m.scheduledAt) < Date.now()
  );
  if (past.length) {
    out.push({
      id: "mtg-awaiting",
      kind: "meeting",
      title: `${past.length} meeting${past.length === 1 ? "" : "s"} awaiting an outcome`,
      detail: "Record what happened so the funnel stays honest",
      href: "/meetings",
      weight: 70,
    });
  }

  // People with a deal in play — which is what a lead is now.
  const waiting = contacts.filter((c) => c.hasOpenDeal && !c.isClient);
  if (waiting.length) {
    out.push({
      id: "leads-open",
      kind: "lead",
      title: `${waiting.length} lead${waiting.length === 1 ? "" : "s"} in progress`,
      detail: waiting
        .slice(0, 3)
        .map((c) => `${c.firstName} ${c.lastName}`.trim())
        .join(", "),
      href: "/leads",
      weight: 60,
    });
  }

  // Deals that have been presented, carry a number, and have not closed.
  const awaitingClose = deals.filter((d) => d.stage === "demo" && d.valueCents > 0);
  if (awaitingClose.length) {
    out.push({
      id: "deals-demo",
      kind: "deal",
      title: `${awaitingClose.length} deal${awaitingClose.length === 1 ? "" : "s"} awaiting a close`,
      detail: `$${Math.round(
        awaitingClose.reduce((s, d) => s + d.valueCents, 0) / 100
      ).toLocaleString()} presented`,
      href: "/deals",
      weight: 50,
    });
  }

  if (unread > 0) {
    out.push({
      id: "inbox-unread",
      kind: "message",
      title: `${unread} unread message${unread === 1 ? "" : "s"}`,
      detail: "Waiting on a reply",
      href: "/inbox",
      weight: 40,
    });
  }

  return out.sort((a, b) => b.weight - a.weight);
}
