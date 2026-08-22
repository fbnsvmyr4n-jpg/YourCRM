import type { SystemQuery, TenantQuery } from "./tenant";

/**
 * What each workspace actually costs to run.
 *
 * The tiers sell "unlimited contacts and users" at $97 alongside an AI
 * assistant and inbound telephony, and both of those cost real money every time
 * somebody uses them. Nobody knows how much, because nothing has ever measured
 * it. A price set against an unmeasured cost is a guess, and the only place the
 * guess shows up is the margin.
 *
 * So this module MEASURES. It does not limit, and nothing here refuses
 * anything. Choosing a policy before there is a month of real data would be
 * inventing the number twice — once to set the limit, once to justify it.
 *
 * Recording is deliberately best-effort: a failure to write a usage row must
 * never fail the thing the customer asked for. Losing a row costs a fraction of
 * a cent of accuracy; failing the request costs the customer their answer.
 */

export type UsageKind = "ai_message" | "voice_minute" | "sms";

/**
 * Published rates, in micro-cents per unit, as of 22 Aug 2026.
 *
 * Micro-cents because a single AI message costs a fraction of a cent: rounding
 * each one to whole cents reports zero until several thousand have gone by,
 * which is exactly the figure this exists to produce.
 *
 * These are OUR cost, not a price. Nothing charges a customer from them yet.
 */
/** One cent, in micro-cents. Every rate below is built from this rather than
 *  written out, because writing them out is how the first version of this file
 *  came out a hundred times too cheap. */
const CENT = 1_000_000;
const DOLLAR = 100 * CENT;

export const RATES = {
  /** Claude Sonnet, per million tokens: $3 in, $15 out. */
  aiInputPerMillionTokens: 3 * DOLLAR,
  aiOutputPerMillionTokens: 15 * DOLLAR,
  /** Twilio inbound voice, per minute, roughly $0.0085. */
  voicePerMinute: 0.85 * CENT,
  /** Twilio SMS, per segment, roughly $0.0079. */
  smsPerSegment: 0.79 * CENT,
} as const;

export function aiCostMicros(inputTokens: number, outputTokens: number): number {
  const input = (inputTokens / 1_000_000) * RATES.aiInputPerMillionTokens;
  const output = (outputTokens / 1_000_000) * RATES.aiOutputPerMillionTokens;
  // Rounded once, at the end. Rounding each half separately loses up to a
  // micro-cent per message, which over a month of traffic is a real number.
  return Math.max(0, Math.round(input + output));
}

export function voiceCostMicros(durationSec: number): number {
  // Billed per minute, rounded UP, because that is how carriers bill. Recording
  // a 20-second call as a third of a minute would under-report the actual cost
  // by two-thirds and make telephony look cheaper than it is.
  const minutes = Math.ceil(Math.max(0, durationSec) / 60);
  return minutes * RATES.voicePerMinute;
}

/**
 * Record one unit of usage.
 *
 * Never throws. The caller has already done the work the customer asked for —
 * the answer is generated, the call is over — and failing at the accounting
 * step would turn a bookkeeping problem into a broken feature.
 */
export async function recordUsage(
  q: TenantQuery,
  input: {
    kind: UsageKind;
    quantity: number;
    costMicros: number;
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await q.rows(
      `INSERT INTO usage_events (id, sub_account_id, kind, quantity, cost_micros, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        `use-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        q.ctx.subAccountId,
        input.kind,
        input.quantity,
        Math.max(0, Math.round(input.costMicros)),
        JSON.stringify(input.detail ?? {}),
      ]
    );
  } catch (err) {
    // Logged, not raised, and without the detail — which can hold token counts
    // but must never grow to hold what was said.
    console.error(`[usage] could not record ${input.kind}:`, (err as Error).message);
  }
}

export type UsageLine = {
  kind: UsageKind;
  events: number;
  quantity: number;
  costMicros: number;
};

export type UsageSummary = {
  since: string;
  lines: UsageLine[];
  totalCostMicros: number;
};

/**
 * This workspace's usage since the start of the current month.
 *
 * Calendar month rather than billing period: the billing anniversary differs
 * per customer and lives in Stripe, and a figure that quietly means a different
 * window for every account is worse than one that plainly means "this month".
 */
export async function usageThisMonth(q: TenantQuery): Promise<UsageSummary> {
  const rows = await q.rows<{
    kind: UsageKind;
    events: string;
    quantity: string;
    cost_micros: string;
  }>(
    `SELECT kind,
            count(*)::text        AS events,
            sum(quantity)::text   AS quantity,
            sum(cost_micros)::text AS cost_micros
       FROM usage_events
      WHERE sub_account_id = $1
        AND occurred_at >= date_trunc('month', now())
      GROUP BY kind
      ORDER BY kind`,
    [q.ctx.subAccountId]
  );

  const lines = rows.map((r) => ({
    kind: r.kind,
    events: Number(r.events),
    quantity: Number(r.quantity),
    costMicros: Number(r.cost_micros),
  }));

  return {
    since: "this month",
    lines,
    totalCostMicros: lines.reduce((sum, l) => sum + l.costMicros, 0),
  };
}

/** Micro-cents as money, for display. Never rounds a real cost down to $0.00. */
export function formatMicros(micros: number): string {
  const dollars = micros / 1_000_000 / 100;
  if (dollars === 0) return "$0.00";
  // Anything that cost something shows as something. "$0.00" beside a hundred
  // AI messages reads as a broken counter rather than as a small bill.
  if (dollars < 0.01) return "<$0.01";
  return `$${dollars.toFixed(2)}`;
}

export type WorkspaceUsage = {
  subAccountId: string;
  name: string;
  isPrimary: boolean;
  aiMessages: number;
  voiceMinutes: number;
  costMicros: number;
};

/**
 * What each of an agency's client workspaces cost this month.
 *
 * This is the rebilling input. An agency on SaaS Pro charges its own clients,
 * and it cannot do that from a single total — it needs to know which client
 * generated which cost. Recording usage per workspace rather than per agency is
 * what makes that possible at all; this is the query that reads it back.
 *
 * Deliberately NOT a tenant-scoped query. It spans every workspace in one
 * agency, which is the whole point, so it runs through `withSystem` and the
 * `agency_id = $1` join is what keeps it inside one customer. That predicate is
 * the entire security of this function: without it, an agency owner would see
 * every other agency's clients and what they spend.
 *
 * Costs only. It reports what a workspace consumed, never anything from inside
 * it — the CRM records themselves stay behind row-level security.
 */
export async function usageByWorkspace(
  q: SystemQuery,
  agencyId: string
): Promise<WorkspaceUsage[]> {
  const rows = await q.rows<{
    sub_account_id: string;
    name: string;
    is_primary: boolean;
    ai_messages: string;
    voice_minutes: string;
    cost_micros: string;
  }>(
    `SELECT sa.id AS sub_account_id,
            sa.name,
            sa.is_primary,
            COALESCE(sum(u.quantity) FILTER (WHERE u.kind = 'ai_message'), 0)::text   AS ai_messages,
            COALESCE(sum(u.quantity) FILTER (WHERE u.kind = 'voice_minute'), 0)::text AS voice_minutes,
            COALESCE(sum(u.cost_micros), 0)::text                                     AS cost_micros
       FROM sub_accounts sa
       -- LEFT JOIN so a workspace that has used nothing still appears at zero.
       -- Dropping it would make an idle client vanish from the agency's own
       -- list, which reads as the workspace having been deleted.
       LEFT JOIN usage_events u
              ON u.sub_account_id = sa.id
             AND u.occurred_at >= date_trunc('month', now())
      WHERE sa.agency_id = $1
        AND sa.deleted_at IS NULL
      GROUP BY sa.id, sa.name, sa.is_primary
      ORDER BY sum(u.cost_micros) DESC NULLS LAST, sa.is_primary DESC, sa.name ASC`,
    [agencyId]
  );

  return rows.map((r) => ({
    subAccountId: r.sub_account_id,
    name: r.name,
    isPrimary: r.is_primary,
    aiMessages: Number(r.ai_messages),
    voiceMinutes: Number(r.voice_minutes),
    costMicros: Number(r.cost_micros),
  }));
}
