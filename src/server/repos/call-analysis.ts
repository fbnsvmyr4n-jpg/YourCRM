import type { CallAnalysis, Finding } from "../agent/call-analysis";
import type { TenantQuery } from "../tenant";

/**
 * Storing what a model made of a call.
 *
 * One row per call, replaced rather than appended. Re-running the analysis is
 * something the post-call pipeline must be able to do — a retry after a
 * timeout, a re-read after the prompt improves — and a table that accumulated
 * opinions would make "what does the CRM think about this call" a question with
 * several answers.
 */

export type StoredAnalysis = CallAnalysis & { callId: string; model: string | null; at: string };

type Row = {
  call_id: string;
  intent: string | null;
  summary: string;
  findings: Finding[];
  grounding: number;
  sentiment: string | null;
  model: string | null;
  created_at: Date;
};

const toStored = (r: Row): StoredAnalysis => ({
  callId: r.call_id,
  intent: r.intent,
  summary: r.summary,
  findings: r.findings,
  grounding: r.grounding,
  sentiment: r.sentiment,
  model: r.model,
  at: r.created_at.toISOString(),
});

export async function saveAnalysis(
  q: TenantQuery,
  callId: string,
  analysis: CallAnalysis,
  model: string
): Promise<void> {
  /* The call is confirmed to be ours before anything is written against it.
     Row-level security refuses a foreign id anyway; this makes the failure a
     no-op rather than a constraint violation surfacing from a background job. */
  const call = await q.one<{ id: string }>(
    `SELECT id FROM calls WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL`,
    [q.ctx.subAccountId, callId]
  );
  if (!call) return;

  await q.rows(
    `INSERT INTO call_analysis
       (call_id, sub_account_id, intent, summary, findings, grounding, sentiment, model)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     ON CONFLICT (call_id) DO UPDATE SET
       intent = EXCLUDED.intent,
       summary = EXCLUDED.summary,
       findings = EXCLUDED.findings,
       grounding = EXCLUDED.grounding,
       sentiment = EXCLUDED.sentiment,
       model = EXCLUDED.model,
       created_at = now()`,
    [
      callId,
      q.ctx.subAccountId,
      analysis.intent,
      analysis.summary,
      JSON.stringify(analysis.findings),
      analysis.grounding,
      analysis.sentiment,
      model,
    ]
  );
}

export async function getAnalysis(q: TenantQuery, callId: string): Promise<StoredAnalysis | null> {
  const row = await q.one<Row>(
    `SELECT call_id, intent, summary, findings, grounding, sentiment, model, created_at
       FROM call_analysis WHERE sub_account_id = $1 AND call_id = $2`,
    [q.ctx.subAccountId, callId]
  );
  return row ? toStored(row) : null;
}

/** Analyses for a set of calls, for a list screen. One query, not one per row. */
export async function analysesFor(
  q: TenantQuery,
  callIds: string[]
): Promise<Map<string, StoredAnalysis>> {
  if (callIds.length === 0) return new Map();
  const rows = await q.rows<Row>(
    `SELECT call_id, intent, summary, findings, grounding, sentiment, model, created_at
       FROM call_analysis WHERE sub_account_id = $1 AND call_id = ANY($2::text[])`,
    [q.ctx.subAccountId, callIds]
  );
  return new Map(rows.map((r) => [r.call_id, toStored(r)]));
}
