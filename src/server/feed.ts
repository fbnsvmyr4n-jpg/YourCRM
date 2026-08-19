import type { Tone } from "@/components/ui/tone";
import type { TenantQuery } from "./tenant";

/**
 * The Home activity feed.
 *
 * Every row carries the timestamp it was derived from, so the label is a fact
 * and the ordering is real. What this replaced was four fixed slots with
 * `time: "just now"` written into one of them as a literal — a feed that said
 * the same four things forever, and claimed they had just happened.
 *
 * Assembled from five timestamped sources in one pass. Reads several
 * repositories' tables, so it lives above them rather than inside one.
 */

export type FeedEvent = {
  /**
   * Key into `iconMap` — must be one it actually has, or the row renders
   * `undefined` as a component and throws.
   */
  icon: string;
  tone: Tone;
  text: string;
  /** ISO timestamp: the stored truth. Every label is derived from this. */
  at: string;
};

export async function activityFeed(q: TenantQuery, limit = 20): Promise<FeedEvent[]> {
  const tenant = q.ctx.subAccountId;
  const events: FeedEvent[] = [];

  // Deals: created, and separately won. A won deal is the single most
  // interesting thing that can appear here, so it gets its own row rather than
  // being folded into "updated".
  const deals = await q.rows<{
    title: string;
    value_cents: string;
    won_at: Date | null;
    created_at: Date;
    contact_name: string | null;
  }>(
    `SELECT d.title, d.value_cents, d.won_at, d.created_at,
            NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), '') AS contact_name
     FROM deals d
     LEFT JOIN contacts c ON c.id = d.contact_id
     WHERE d.sub_account_id = $1 AND d.deleted_at IS NULL
     ORDER BY GREATEST(d.created_at, COALESCE(d.won_at, d.created_at)) DESC
     LIMIT $2`,
    [tenant, limit]
  );

  for (const d of deals) {
    const who = d.contact_name ? ` with ${d.contact_name}` : "";
    if (d.won_at) {
      events.push({
        icon: "dollar",
        tone: "green",
        text: `Won ${d.title}${who} — $${Math.round(Number(d.value_cents) / 100).toLocaleString()}`,
        at: d.won_at.toISOString(),
      });
    } else {
      events.push({
        icon: "bar-chart",
        tone: "amber",
        text: `New deal: ${d.title}${who}`,
        at: d.created_at.toISOString(),
      });
    }
  }

  // Messages received. Sent mail is the user's own action and is not news to
  // them; an inbound message is.
  const messages = await q.rows<{ subject: string; sent_at: Date; contact_name: string | null }>(
    `SELECT m.subject, m.sent_at,
            NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), '') AS contact_name
     FROM messages m
     LEFT JOIN contacts c ON c.id = m.contact_id
     WHERE m.sub_account_id = $1 AND m.deleted_at IS NULL AND m.direction = 'received'
     ORDER BY m.sent_at DESC LIMIT $2`,
    [tenant, limit]
  );
  for (const m of messages) {
    events.push({
      icon: "message",
      tone: "blue",
      text: `${m.contact_name ?? "Someone"} sent “${m.subject || "(no subject)"}”`,
      at: m.sent_at.toISOString(),
    });
  }

  // Meetings, once an outcome has been recorded. A meeting nobody has marked
  // up has not happened as far as the record is concerned, so announcing it
  // would be inventing an event.
  const meetings = await q.rows<{ topic: string; outcome: string; scheduled_at: Date }>(
    `SELECT topic, outcome, scheduled_at
     FROM meetings
     WHERE sub_account_id = $1 AND deleted_at IS NULL AND outcome <> 'scheduled'
     ORDER BY scheduled_at DESC LIMIT $2`,
    [tenant, limit]
  );
  for (const m of meetings) {
    events.push({
      icon: "calendar",
      tone: m.outcome === "no_show" ? "red" : "purple",
      text: `${m.topic || "Meeting"} — ${m.outcome.replace("_", "-")}`,
      at: m.scheduled_at.toISOString(),
    });
  }

  const calls = await q.rows<{ caller_name: string; received_at: Date; duration_sec: number }>(
    `SELECT caller_name, received_at, duration_sec
     FROM calls
     WHERE sub_account_id = $1 AND deleted_at IS NULL
     ORDER BY received_at DESC LIMIT $2`,
    [tenant, limit]
  );
  for (const c of calls) {
    events.push({
      icon: "phone",
      tone: "purple",
      text: `Call with ${c.caller_name || "an unknown caller"} · ${Math.max(1, Math.round(c.duration_sec / 60))} min`,
      at: c.received_at.toISOString(),
    });
  }

  // Anything a person deliberately logged: notes, outreach, and the rest.
  const logged = await q.rows<{ title: string; kind: string; at: Date }>(
    `SELECT title, kind, at
     FROM activities
     WHERE sub_account_id = $1
     ORDER BY at DESC LIMIT $2`,
    [tenant, limit]
  );
  for (const a of logged) {
    events.push({
      icon: a.kind === "note" ? "file-text" : "user-plus",
      tone: "blue",
      text: a.title,
      at: a.at.toISOString(),
    });
  }

  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}
