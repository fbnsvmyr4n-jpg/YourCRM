import { listCalls } from "./repos/calls";
import { deadJobs } from "./repos/outbox";
import { CALL_ANALYSIS, QUOTE_EMAIL } from "./outbox-handlers";
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

/**
 * `stuck` is the odd one out, deliberately.
 *
 * Every other kind is work a PERSON has not done yet. This one is work the
 * SYSTEM promised and then gave up on — a quotation whose email was refused,
 * a call it could not read. Those failures existed only in one `console.error`
 * and a row nobody queries, which meant the person who needed the email found
 * out from the client.
 */
export type NotificationKind = "meeting" | "lead" | "message" | "call" | "deal" | "stuck";

export type Notification = {
  id: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  href: string;
  /** Sorts the feed. Higher is more urgent. */
  weight: number;
};

/**
 * What a given kind of abandoned job means to a person, and where they go.
 *
 * Keyed by handler name so a handler added later without an entry here still
 * SURFACES — see the fallback below. A job nobody can see is the failure this
 * whole section exists to prevent, and forgetting to add a line to a lookup
 * table should not silently recreate it.
 */
const STUCK_META: Record<string, { noun: (n: number) => string; verb: string; href: string }> = {
  [QUOTE_EMAIL]: {
    noun: (n) => (n === 1 ? "quotation" : "quotations"),
    verb: "could not be emailed",
    href: "/chat",
  },
  [CALL_ANALYSIS]: {
    noun: (n) => (n === 1 ? "call" : "calls"),
    verb: "could not be read",
    href: "/voice-agents",
  },
};

/* Worded to agree with either count — "could not be completed" reads correctly
   for one task and for nine, which a verb like "were abandoned" does not. */
const FALLBACK_STUCK = {
  noun: (n: number) => (n === 1 ? "background task" : "background tasks"),
  verb: "could not be completed",
  href: "/settings",
};

function groupByHandler(jobs: { handler: string; lastError: string | null }[]) {
  const map = new Map<string, { handler: string; lastError: string | null }[]>();
  for (const job of jobs) {
    const list = map.get(job.handler);
    if (list) list.push(job);
    else map.set(job.handler, [job]);
  }
  return map;
}

/**
 * A provider's error, cut down to the part a person can act on.
 *
 * These arrive as JSON — `Resend returned 403 {"statusCode":403,...,"message":
 * "You can only send testing emails to your own address"}` — and the message
 * is the only part worth reading. Pulled out when it is there, trimmed when it
 * is not, because a notification that wraps three lines of JSON is one nobody
 * reads at all.
 */
export function shortenError(raw: string | null): string {
  if (!raw) return "";
  const message = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
  const text = (message ?? raw).replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

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

  /*
     Work the system gave up on, first — above everything a person merely has
     not got to yet.

     A quotation somebody approved that never reached the client is the most
     expensive thing this feed can carry: the decision was made, the price went
     nowhere, and nothing else on any screen shouts about it. Until now it lived
     in a `console.error` inside a scheduled sweep and a row nobody queries,
     which is another way of saying the client told you.

     The provider's own words are carried through rather than replaced with
     "something went wrong". "You can only send testing emails to your own
     address" tells somebody exactly what to fix; a friendly paraphrase does
     not, and this is a feed for people who have to act.
  */
  const stuck = await deadJobs(q);
  for (const [handler, jobs] of groupByHandler(stuck)) {
    const meta = STUCK_META[handler] ?? FALLBACK_STUCK;
    out.push({
      id: `stuck-${handler}`,
      kind: "stuck",
      title: `${jobs.length} ${meta.noun(jobs.length)} ${meta.verb}`,
      detail: shortenError(jobs[0].lastError) || "No reason was recorded",
      href: meta.href,
      // Above the most time-critical human task. Somebody's client is waiting
      // on something this workspace believes it already sent.
      weight: 110,
    });
  }

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
