import type { TenantQuery } from "../tenant";

/**
 * The outbox, as rows.
 *
 * Three operations, deliberately in three separate transactions:
 *
 *   `enqueue`  runs inside the caller's transaction — that is the whole point
 *              of the table, so it takes the caller's querier and never opens
 *              one of its own.
 *   `claim`    leases due work in a SHORT transaction: it stamps an attempt
 *              and pushes `run_after` into the future so no other worker will
 *              take the same row.
 *   `settle`   records what happened, in another short transaction.
 *
 * The handler runs BETWEEN claim and settle, outside any transaction. A mail
 * provider taking ten seconds must not hold a database connection and a row
 * lock while it does, and this codebase runs with a pool one connection deep
 * under test — a handler that awaited an HTTP call inside the claiming
 * transaction would deadlock against its own settle.
 *
 * The lease is what makes a crash recoverable: a worker that dies mid-job
 * leaves the row leased, the lease expires, and the row becomes due again.
 * Nothing has to notice the death.
 */

export type OutboxRow = {
  id: string;
  handler: string;
  payload: Record<string, string>;
  /** Attempts INCLUDING this one, because claiming stamps it. */
  attempts: number;
};

type Row = {
  id: string;
  handler: string;
  payload: Record<string, string> | null;
  attempts: number;
};

/**
 * How long a claimed job is ours for.
 *
 * Longer than any handler's own timeout — the mail send caps at 10s and the
 * call analysis at 30s — because a lease that expires while the handler is
 * still working invites a second worker to run the same job alongside the
 * first, which is precisely the duplicate the design is trying to avoid.
 */
export const LEASE_SECONDS = 120;

/**
 * Queue a job in the caller's transaction.
 *
 * Returns the row id, which is the handler's idempotency key when it talks to
 * an external service — stable across every retry of this job, and different
 * for every other job.
 *
 * A `dedupeKey` collision is not an error: the job is already queued, so the
 * existing id comes back and the caller carries on. That is what makes a
 * double-pressed button, a retried webhook and a replayed call all safe.
 *
 * The one collision that DOES change something is a job that was given up on.
 * Queueing is a request for the work to happen, and a person pressing Send
 * again on a quotation that failed is asking for exactly that — without this
 * the dedupe key would make the retry silently do nothing, for ever, which is
 * the worst of both behaviours. A `done` row is never revived, because that
 * would email a client a second copy; a `pending` row is left exactly as it
 * is, so pressing twice cannot reset a backoff and hammer a provider.
 */
export async function enqueue(
  q: TenantQuery,
  job: { id: string; handler: string; payload: Record<string, string>; dedupeKey?: string | null }
): Promise<string> {
  const row = await q.one<{ id: string }>(
    `INSERT INTO outbox (id, sub_account_id, handler, payload, dedupe_key)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (sub_account_id, handler, dedupe_key) WHERE dedupe_key IS NOT NULL
       DO UPDATE SET
         status     = CASE WHEN outbox.status = 'dead' THEN 'pending' ELSE outbox.status END,
         attempts   = CASE WHEN outbox.status = 'dead' THEN 0         ELSE outbox.attempts END,
         run_after  = CASE WHEN outbox.status = 'dead' THEN now()     ELSE outbox.run_after END,
         last_error = CASE WHEN outbox.status = 'dead' THEN NULL      ELSE outbox.last_error END,
         settled_at = CASE WHEN outbox.status = 'dead' THEN NULL      ELSE outbox.settled_at END
     RETURNING id`,
    [job.id, q.ctx.subAccountId, job.handler, JSON.stringify(job.payload), job.dedupeKey ?? null]
  );
  /* `DO UPDATE` rather than `DO NOTHING`, so the conflicting row is RETURNED.
     `DO NOTHING` returns nothing at all, and the caller would be told the
     enqueue failed when in truth the job was already waiting. */
  return row?.id ?? job.id;
}

/**
 * Take up to `limit` due jobs for this workspace.
 *
 * `FOR UPDATE SKIP LOCKED` so two workers running at once divide the work
 * instead of fighting over the head of the queue — one of them simply steps
 * over the rows the other is holding.
 *
 * The attempt is counted HERE rather than on completion. A job that kills the
 * worker every time it runs would otherwise retry for ever, having never
 * survived long enough to record a failure.
 */
export async function claim(q: TenantQuery, limit: number): Promise<OutboxRow[]> {
  const rows = await q.rows<Row>(
    `UPDATE outbox SET
       attempts  = attempts + 1,
       run_after = now() + ($3 || ' seconds')::interval
     WHERE id IN (
       SELECT id FROM outbox
        WHERE sub_account_id = $1
          AND status = 'pending'
          AND run_after <= now()
        ORDER BY run_after ASC, created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     RETURNING id, handler, payload, attempts`,
    [q.ctx.subAccountId, limit, String(LEASE_SECONDS)]
  );
  return rows.map((r) => ({
    id: r.id,
    handler: r.handler,
    payload: r.payload ?? {},
    attempts: r.attempts,
  }));
}

/** Finished, for good. */
export async function markDone(q: TenantQuery, id: string): Promise<void> {
  await q.rows(
    `UPDATE outbox SET status = 'done', settled_at = now(), last_error = NULL
      WHERE sub_account_id = $1 AND id = $2`,
    [q.ctx.subAccountId, id]
  );
}

/** Failed, and worth another go — due again after `delaySeconds`. */
export async function markRetry(
  q: TenantQuery,
  id: string,
  delaySeconds: number,
  error: string
): Promise<void> {
  await q.rows(
    `UPDATE outbox SET run_after = now() + ($3 || ' seconds')::interval, last_error = $4
      WHERE sub_account_id = $1 AND id = $2`,
    [q.ctx.subAccountId, id, String(delaySeconds), error.slice(0, 500)]
  );
}

/** Given up on. Stays in the table: a job nobody can see is a job nobody fixes. */
export async function markDead(q: TenantQuery, id: string, error: string): Promise<void> {
  await q.rows(
    `UPDATE outbox SET status = 'dead', settled_at = now(), last_error = $3
      WHERE sub_account_id = $1 AND id = $2`,
    [q.ctx.subAccountId, id, error.slice(0, 500)]
  );
}

/** Is there anything waiting? Used to decide whether a drain is worth opening. */
export async function pendingCount(q: TenantQuery): Promise<number> {
  const row = await q.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM outbox
      WHERE sub_account_id = $1 AND status = 'pending'`,
    [q.ctx.subAccountId]
  );
  return Number(row?.n ?? 0);
}

/**
 * Where one job got to, by the key that identifies it.
 *
 * For the screen that queued it. A person who has just pressed Approve is owed
 * a straight answer about whether their client has the price, and "queued" is
 * three different truths: it has gone, it is waiting, or it was given up on.
 * Telling somebody "we'll keep trying" about a job that has stopped is worse
 * than saying nothing.
 */
export async function findJob(
  q: TenantQuery,
  handler: string,
  dedupeKey: string
): Promise<{ status: string; attempts: number; lastError: string | null } | null> {
  const row = await q.one<{ status: string; attempts: number; last_error: string | null }>(
    `SELECT status, attempts, last_error FROM outbox
      WHERE sub_account_id = $1 AND handler = $2 AND dedupe_key = $3`,
    [q.ctx.subAccountId, handler, dedupeKey]
  );
  return row ? { status: row.status, attempts: row.attempts, lastError: row.last_error } : null;
}

/** Jobs that were given up on, for the health check and for a person to read. */
export async function deadJobs(
  q: TenantQuery,
  limit = 20
): Promise<{ id: string; handler: string; attempts: number; lastError: string | null }[]> {
  const rows = await q.rows<{
    id: string;
    handler: string;
    attempts: number;
    last_error: string | null;
  }>(
    `SELECT id, handler, attempts, last_error FROM outbox
      WHERE sub_account_id = $1 AND status = 'dead'
      ORDER BY settled_at DESC LIMIT $2`,
    [q.ctx.subAccountId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    handler: r.handler,
    attempts: r.attempts,
    lastError: r.last_error,
  }));
}
