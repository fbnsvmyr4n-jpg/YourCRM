import { listActivity } from "./activity-repo";
import { listCalls } from "./calls-repo";
import { listDeals } from "./deals-repo";
import { listLeads } from "./leads-repo";
import { listMessages } from "./inbox-repo";
import type { Tone } from "@/components/ui/tone";

/**
 * The dashboard's activity feed — what actually happened, newest first.
 *
 * The old version was not a feed. It was four hardcoded slots, one per entity
 * (`leads[0]`, `meetings[0]`, `wonDeals[0]`, `received[0]`), so it could never
 * show more than four things and never ordered them against each other. Worse,
 * the lead line carried `time: "just now"` as a **literal string** — on the
 * real store that read "New lead: jamey james · just now" for a lead created
 * five days earlier. The label was not derived from anything.
 *
 * Every row here carries the `at` it was built from, so the time is a fact and
 * the ordering is real. See [[project-no-fake-data]].
 *
 * Lives above the repos rather than inside one: it reads five of them, and
 * `calls-repo` already imports `leads-repo`, so putting this in a repo would
 * close an import cycle. Same shape as `lead-status.ts` and `reports.ts`.
 */

export type FeedEvent = {
  /** Key into `iconMap` — must be one it actually has, or the row renders
   *  `undefined` as a component and throws. */
  icon: string;
  tone: Tone;
  text: string;
  /** ISO timestamp — the stored truth. The label is derived from this. */
  at: string;
};

// 20 rather than 12: the list scrolls inside its card, so extra rows cost no
// layout at all — they just make more of the history reachable.
export async function activityFeed(limit = 20): Promise<FeedEvent[]> {
  const [leads, deals, messages, calls, logged] = await Promise.all([
    listLeads(),
    listDeals(),
    listMessages(),
    listCalls(),
    listActivity(),
  ]);

  const events: FeedEvent[] = [];

  for (const l of leads) {
    if (!l.createdAt) continue;
    events.push({ icon: "user-plus", tone: "blue", text: `New lead: ${l.name}`, at: l.createdAt });
  }

  // Only won deals carry a timestamp of their own — `wonAt` is stamped on the
  // move into Closed Won. An open deal has no moment to report.
  for (const d of deals) {
    if (d.stage !== "won" || !d.wonAt) continue;
    events.push({
      icon: "dollar",
      tone: "green",
      text: `Deal won: ${d.title} — $${d.value.toLocaleString()}`,
      at: d.wonAt,
    });
  }

  for (const m of messages) {
    if (m.direction !== "received" || m.trashed || !m.at) continue;
    events.push({ icon: "message", tone: "purple", text: `New message from ${m.name}`, at: m.at });
  }

  // The voice agent is one of this CRM's headline features and never appeared
  // in the feed at all.
  for (const c of calls) {
    if (!c.receivedAt) continue;
    events.push({
      icon: "phone",
      tone: "amber",
      text: `Call answered: ${c.callerName || "Unknown caller"}`,
      at: c.receivedAt,
    });
  }

  // Notes, calls and emails the user logged against a contact.
  for (const a of logged) {
    if (!a.at) continue;
    events.push({ icon: "file-text", tone: "red", text: a.title, at: a.at });
  }

  // Meetings are deliberately absent. Their stored `date` is when the meeting
  // *is*, not a record of something that occurred — and with no outcome
  // recorded, listing a past one as history would assert it went ahead. The
  // Upcoming Meetings card already covers them.

  return events
    .filter((e) => Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}
