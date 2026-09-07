import { withTenant, type TenantContext, type TenantQuery } from "./tenant";
import { claim, enqueue, markDead, markDone, markRetry, type OutboxRow } from "./repos/outbox";

/**
 * Work that must survive us.
 *
 * A change to the database and a consequence of that change — an email, an
 * analysis, a notification — are two different systems, and either can fail
 * after the other succeeded. Doing them in sequence means a crash in the gap
 * leaves the two disagreeing, permanently and silently: a customer holding a
 * quotation the CRM believes was never sent, a finished call whose analysis
 * was lost to one timeout.
 *
 * So the consequence is written down inside the SAME transaction as the
 * change. Either both happened or neither did. Something else does the work
 * afterwards, retrying until it lands.
 *
 * ── The contract every handler has to keep ───────────────────────────────
 *
 * **Delivery is at least once.** A worker that dies after the provider
 * accepted its request but before the row was settled will run the job again.
 * That is not a bug to be engineered away — it is what "the network can fail
 * anywhere" means — so a handler must either be naturally repeatable, or make
 * itself repeatable with the job id, which is stable across retries and
 * unique across jobs.
 *
 * **Handlers re-read.** The payload carries ids, never content. A job queued
 * two minutes ago must act on the record as it is NOW: a quotation somebody
 * has since discarded must not be emailed because the payload still holds the
 * old total.
 *
 * **Handlers say whether a failure is worth repeating.** A mail provider
 * refusing an address will refuse it for ever, and retrying six times only
 * delays the moment somebody finds out. A timeout is the opposite. Only the
 * handler knows which it got, so only the handler decides.
 */

/* ------------------------------------------------------------------ */
/* What a handler returns                                              */
/* ------------------------------------------------------------------ */

export type JobOutcome =
  | { ok: true; note?: string }
  | { ok: false; retry: boolean; error: string };

export type JobContext = {
  /** Stable across retries, unique across jobs — the provider idempotency key. */
  id: string;
  /** Including the one running now. */
  attempts: number;
  /**
   * The workspace this job belongs to — NOT an open transaction.
   *
   * A handler opens what it needs, in the order it needs, because some of them
   * genuinely need both a system read and a tenant one: naming the person who
   * approved a quotation means reading `users`, which is agency-level. Handed a
   * transaction already in progress, such a handler would take a second
   * connection from the pool while holding the first — a deadlock the moment
   * the pool is busy, and immediately under test, where it is one deep.
   *
   * So the rule this codebase already follows applies here too: resolve the
   * system-level reads first, then open the tenant transaction.
   */
  ctx: TenantContext;
};

export type OutboxHandler = {
  name: string;
  run: (payload: Record<string, string>, job: JobContext) => Promise<JobOutcome>;
};

export type HandlerRegistry = Map<string, OutboxHandler>;

export function buildRegistry(handlers: readonly OutboxHandler[]): HandlerRegistry {
  const map = new Map<string, OutboxHandler>();
  for (const h of handlers) {
    /* Two handlers under one name means whichever loaded last silently wins,
       and jobs queued for the other run the wrong code. Refuse at startup,
       where it is a crash somebody sees, rather than at 3am on one row. */
    if (map.has(h.name)) throw new Error(`Duplicate outbox handler: ${h.name}`);
    map.set(h.name, h);
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Retry policy                                                        */
/* ------------------------------------------------------------------ */

/**
 * How many goes a job gets before it is left for a person.
 *
 * Six, with the backoff below, spans a little under two hours. That covers the
 * failures worth waiting out — a provider restarting, a network partition, a
 * rate limit — and stops well short of a job that quietly retries all week
 * while whoever needed the email assumes it went.
 */
export const MAX_ATTEMPTS = 6;

/**
 * The wait before the next attempt, in seconds.
 *
 * Exponential from 30 seconds, capped at an hour. Deliberately WITHOUT jitter:
 * jitter exists to stop thousands of clients retrying in lockstep after a
 * shared outage, which is not this system's shape — jobs here arrive one at a
 * time from one small workspace — and a random delay would make the retry
 * ladder untestable in exchange for solving a problem we do not have.
 */
export function backoffSeconds(attempts: number): number {
  const base = 30 * Math.pow(4, Math.max(0, attempts - 1));
  return Math.min(base, 3600);
}

/* ------------------------------------------------------------------ */
/* Queueing                                                            */
/* ------------------------------------------------------------------ */

function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Queue a job as part of whatever the caller is already doing.
 *
 * Takes the caller's querier on purpose: passed a transaction that later rolls
 * back, this row rolls back with it, and the promise never outlives the change
 * that promised it.
 *
 * Refuses an unknown handler HERE, at the moment of queueing, where the caller
 * is on screen and the error is attributable — not two minutes later inside a
 * worker where the only trace is a dead row.
 */
export async function queueJob(
  q: TenantQuery,
  registry: HandlerRegistry,
  job: { handler: string; payload: Record<string, string>; dedupeKey?: string | null }
): Promise<string> {
  if (!registry.has(job.handler)) throw new Error(`Unknown outbox handler: ${job.handler}`);
  return enqueue(q, {
    id: newJobId(),
    handler: job.handler,
    payload: job.payload,
    dedupeKey: job.dedupeKey ?? null,
  });
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

export type DrainReport = {
  ran: number;
  done: number;
  retried: number;
  dead: number;
};

/**
 * What a result MEANS: settle it, wait, or give up.
 *
 * Pure, and separate from everything that writes, because this is the rule the
 * whole mechanism turns on and it deserves to be readable and testable on its
 * own — no queue, no database, no clock.
 */
export function decide(
  outcome: JobOutcome,
  attempts: number
): { status: "done" | "retried" | "dead"; delaySeconds?: number; error?: string } {
  if (outcome.ok) return { status: "done" };
  /* Two ways to stop: the handler says this will never work, or we have asked
     enough times. Either way the row stays in the table as `dead`, because a
     job that vanishes is a job nobody fixes. */
  if (!outcome.retry || attempts >= MAX_ATTEMPTS) {
    return { status: "dead", error: outcome.error };
  }
  return { status: "retried", delaySeconds: backoffSeconds(attempts), error: outcome.error };
}

/** Write down what `decide` decided. */
export async function settleJob(
  q: TenantQuery,
  row: OutboxRow,
  outcome: JobOutcome
): Promise<"done" | "retried" | "dead"> {
  const verdict = decide(outcome, row.attempts);
  if (verdict.status === "done") await markDone(q, row.id);
  else if (verdict.status === "dead") await markDead(q, row.id, verdict.error ?? "");
  else await markRetry(q, row.id, verdict.delaySeconds ?? 30, verdict.error ?? "");
  return verdict.status;
}

/**
 * Work through one workspace's queue.
 *
 * **Three separate transactions per job, and the separation is the design.**
 *
 * Claiming commits on its own, so the attempt it stamps SURVIVES a crash. Were
 * the claim, the work and the settle one transaction, a job that killed the
 * process would roll its own attempt back and be immediately due again —
 * retrying for ever at full speed, which is the one failure a retry ladder
 * exists to prevent.
 *
 * The handler then gets a transaction of its own, so what it writes is atomic
 * with nothing else; and the settle gets a third, so it still happens when the
 * handler's transaction rolls back. A settle written inside a failed handler's
 * transaction would be lost with it, and the job would look untried.
 *
 * Bounded by `limit` rather than looping until empty: this runs inside a
 * serverless invocation with a wall clock, and a queue growing faster than one
 * pass can drain it must not hold the request open until the platform kills
 * it.
 */
export async function drain(
  ctx: TenantContext,
  registry: HandlerRegistry,
  limit = 10
): Promise<DrainReport> {
  const rows = await withTenant(ctx, (q) => claim(q, limit));
  const report: DrainReport = { ran: rows.length, done: 0, retried: 0, dead: 0 };

  for (const row of rows) {
    const handler = registry.get(row.handler);
    let outcome: JobOutcome;

    if (!handler) {
      /* A row naming a handler this deployment does not have — usually a
         rollback, where the code that queued it is briefly gone. Retrying is
         right: its own deployment coming back should find the work waiting.
         Attempts still count, so a name that never returns eventually dies. */
      outcome = { ok: false, retry: true, error: `No handler named ${row.handler}` };
    } else {
      try {
        outcome = await handler.run(row.payload, {
          id: row.id,
          attempts: row.attempts,
          ctx,
        });
      } catch (err) {
        /* An exception is an UNKNOWN failure, and unknown means retry. Giving
           up on a fault nobody has classified is how a transient bug becomes a
           lost email; the attempt ceiling stops that being unbounded. */
        outcome = {
          ok: false,
          retry: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const result = await withTenant(ctx, (q) => settleJob(q, row, outcome));
    report[result] += 1;
  }
  return report;
}
