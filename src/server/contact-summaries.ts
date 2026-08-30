import type { TenantQuery } from "./tenant";

/**
 * Everything the contact panel needs beyond the record itself.
 *
 * The version this replaces joined a contact to their deals by comparing
 * names — `sameName(deal.contact, fullName(contact))` — so renaming somebody
 * silently emptied their history and their revenue. Every join here is a
 * foreign key, which is the whole point of the schema change.
 *
 * Built for every contact in one pass. Called per contact it would re-read
 * deals, meetings, calls and messages once per row; the panel needs to switch
 * between people instantly, without a round trip each time.
 */

export type TimelineEntry = {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  at: string;
  /** Integer cents, on the entries that involve money. */
  amountCents?: number;
  /**
   * Where the entry came from.
   *
   * Everything except `logged` is an echo of a record that lives elsewhere.
   * Nothing is editable from here any more — the log is append-only — but the
   * distinction still matters for what the entry links to.
   */
  source: "logged" | "deal" | "meeting" | "call" | "message";
};

export type ContactSummary = {
  timeline: TimelineEntry[];
  /** Real money from deals actually won. Never derived from a name or a guess. */
  wonValueCents: number;
  openValueCents: number;
  deals: { id: string; title: string; valueCents: number; stage: string; won: boolean }[];
};

const OPEN_STAGES = ["prospect", "discovery", "demo"];
/** Stages that mean the sale happened. Mirrors `isWonStage` in data/pipeline. */
const WON_STAGES = ["won", "delivery", "referral"];

/**
 * Which pot a deal's money belongs in: won, still open, or neither.
 *
 * Pure and exported because this is the arithmetic behind the two figures on a
 * contact, and "is the revenue accurate" is not a question to answer by
 * reading the code and hoping.
 *
 * THE BUG THIS FIXES. It used to be `won_at !== null` for won, else
 * `OPEN_STAGES.includes(stage)` for open — and nothing else. A deal dragged
 * straight from Demo to Delivery keeps a NULL `won_at` (`moveDeal` only stamps
 * it on the way into Won, and preserves whatever is there for Delivery and
 * Referral), and Delivery is in neither list. So its value was counted in
 * NEITHER pot: money that existed on the board and simply did not appear on
 * the contact. Same for Referral.
 *
 * A deal in a won stage IS won — that is what `isWonStage` says everywhere
 * else in the app — so the stage now counts as well as the timestamp. `lost`
 * belongs to neither pot, which is the one exclusion that is deliberate.
 */
export function dealMoneyBucket(stage: string, wonAt: Date | string | null): "won" | "open" | "none" {
  if (wonAt !== null || WON_STAGES.includes(stage)) return "won";
  if (OPEN_STAGES.includes(stage)) return "open";
  return "none";
}

export async function contactSummaries(
  q: TenantQuery,
  contactIds: string[]
): Promise<Record<string, ContactSummary>> {
  const out: Record<string, ContactSummary> = {};
  for (const id of contactIds) {
    out[id] = { timeline: [], wonValueCents: 0, openValueCents: 0, deals: [] };
  }
  if (contactIds.length === 0) return out;

  const tenant = q.ctx.subAccountId;
  const push = (contactId: string | null, entry: TimelineEntry) => {
    if (contactId && out[contactId]) out[contactId].timeline.push(entry);
  };

  // --- Deals: the money, and the stage changes worth seeing ------------------
  const deals = await q.rows<{
    id: string;
    contact_id: string;
    title: string;
    value_cents: string;
    stage: string;
    won_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, contact_id, title, value_cents, stage, won_at, created_at
     FROM deals
     WHERE sub_account_id = $1 AND deleted_at IS NULL AND contact_id = ANY($2)
     ORDER BY created_at DESC`,
    [tenant, contactIds]
  );

  for (const d of deals) {
    const summary = out[d.contact_id];
    if (!summary) continue;
    const cents = Number(d.value_cents);
    const won = d.won_at !== null;

    summary.deals.push({ id: d.id, title: d.title, valueCents: cents, stage: d.stage, won });
    const bucket = dealMoneyBucket(d.stage, d.won_at);
    if (bucket === "won") summary.wonValueCents += cents;
    else if (bucket === "open") summary.openValueCents += cents;

    push(d.contact_id, {
      id: `deal-${d.id}`,
      kind: won ? "won" : "deal",
      title: won ? `Won ${d.title}` : d.title,
      at: (d.won_at ?? d.created_at).toISOString(),
      amountCents: cents,
      source: "deal",
    });
  }

  // --- Meetings --------------------------------------------------------------
  const meetings = await q.rows<{
    id: string;
    contact_id: string;
    topic: string;
    scheduled_at: Date;
    outcome: string;
  }>(
    `SELECT id, contact_id, topic, scheduled_at, outcome
     FROM meetings
     WHERE sub_account_id = $1 AND deleted_at IS NULL AND contact_id = ANY($2)`,
    [tenant, contactIds]
  );
  for (const m of meetings) {
    push(m.contact_id, {
      id: `meeting-${m.id}`,
      kind: "meeting",
      title: m.topic || "Meeting",
      // The outcome is shown rather than inferred: a past meeting nobody has
      // marked up is still "scheduled", and saying otherwise invents an event.
      detail: m.outcome === "scheduled" ? "Outcome not recorded" : m.outcome.replace("_", "-"),
      at: m.scheduled_at.toISOString(),
      source: "meeting",
    });
  }

  // --- Calls -----------------------------------------------------------------
  const calls = await q.rows<{
    id: string;
    contact_id: string;
    received_at: Date;
    duration_sec: number;
    summary: string | null;
  }>(
    `SELECT id, contact_id, received_at, duration_sec, summary
     FROM calls
     WHERE sub_account_id = $1 AND deleted_at IS NULL AND contact_id = ANY($2)`,
    [tenant, contactIds]
  );
  for (const c of calls) {
    push(c.contact_id, {
      id: `call-${c.id}`,
      kind: "call",
      title: `Call · ${Math.round(c.duration_sec / 60)} min`,
      detail: c.summary ?? undefined,
      at: c.received_at.toISOString(),
      source: "call",
    });
  }

  // --- Messages --------------------------------------------------------------
  const messages = await q.rows<{
    id: string;
    contact_id: string;
    subject: string;
    direction: string;
    sent_at: Date;
  }>(
    `SELECT id, contact_id, subject, direction, sent_at
     FROM messages
     WHERE sub_account_id = $1 AND deleted_at IS NULL AND contact_id = ANY($2)`,
    [tenant, contactIds]
  );
  for (const msg of messages) {
    push(msg.contact_id, {
      id: `message-${msg.id}`,
      kind: "email",
      title: msg.subject || "(no subject)",
      detail: msg.direction === "sent" ? "Sent" : "Received",
      at: msg.sent_at.toISOString(),
      source: "message",
    });
  }

  // --- Logged activity -------------------------------------------------------
  const activity = await q.rows<{
    id: string;
    entity_id: string;
    kind: string;
    title: string;
    detail: string | null;
    amount_cents: string | null;
    at: Date;
  }>(
    `SELECT id, entity_id, kind, title, detail, amount_cents, at
     FROM activities
     WHERE sub_account_id = $1 AND entity_type = 'contact' AND entity_id = ANY($2)`,
    [tenant, contactIds]
  );
  for (const a of activity) {
    push(a.entity_id, {
      id: a.id,
      kind: a.kind,
      title: a.title,
      detail: a.detail ?? undefined,
      // Null stays undefined rather than becoming 0 — "no amount" and "worth
      // nothing" are different claims.
      amountCents: a.amount_cents === null ? undefined : Number(a.amount_cents),
      at: a.at.toISOString(),
      source: "logged",
    });
  }

  for (const summary of Object.values(out)) {
    summary.timeline.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }
  return out;
}
