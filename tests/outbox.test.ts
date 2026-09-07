import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";
import type { JobOutcome, OutboxHandler } from "../src/server/outbox";

/**
 * The transactional outbox.
 *
 * What this table is for is narrow and worth stating: a change to the database
 * and a consequence of that change are two systems, and either can fail after
 * the other succeeded. Sending a quotation and then marking it sent leaves a
 * customer holding a price the CRM believes was never quoted, if the process
 * dies in the gap.
 *
 * So the properties tested here are the ones that make that impossible, and
 * every one of them is a failure rather than a success:
 *
 *   - a rolled-back change takes its promised work down with it;
 *   - a crashed worker's job comes back, having spent an attempt;
 *   - a job that will never succeed stops, rather than retrying all week;
 *   - a job queued twice is one job;
 *   - one workspace can never see or run another's work.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let outbox: typeof import("../src/server/outbox");
let repo: typeof import("../src/server/repos/outbox");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctxFor(TENANT_B), fn);
const CTX_A = ctxFor(TENANT_A);

/** A handler whose result the test dictates, and which records that it ran. */
function spy(name: string, outcome: JobOutcome | (() => Promise<JobOutcome>)) {
  const calls: { payload: Record<string, string>; id: string; attempts: number }[] = [];
  const handler: OutboxHandler = {
    name,
    run: async (payload, job) => {
      calls.push({ payload, id: job.id, attempts: job.attempts });
      return typeof outcome === "function" ? outcome() : outcome;
    },
  };
  return { handler, calls };
}

const rowOf = (id: string) =>
  db
    .seed(`SELECT 1`)
    .then(() =>
      inA((q) =>
        q.one<{ status: string; attempts: number; last_error: string | null; due: boolean }>(
          `SELECT status, attempts, last_error, (run_after <= now()) AS due
             FROM outbox WHERE id = $2 AND sub_account_id = $1`,
          [TENANT_A, id]
        )
      )
    );

beforeAll(async () => {
  db = await startTestDb();
  ({ closePool } = await import("../src/server/db"));
  ({ withTenant } = await import("../src/server/tenant"));
  outbox = await import("../src/server/outbox");
  repo = await import("../src/server/repos/outbox");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  await db.seed(`DELETE FROM outbox;`);
});

describe("queueing", () => {
  it("refuses a handler nothing can run", async () => {
    /* Caught while the caller is on screen and the error is attributable —
       not two minutes later inside a worker, where the only trace is a dead
       row naming code that never existed. */
    const registry = outbox.buildRegistry([spy("email", { ok: true }).handler]);
    await expect(
      inA((q) => outbox.queueJob(q, registry, { handler: "no_such_thing", payload: {} }))
    ).rejects.toThrow(/Unknown outbox handler/);
  });

  it("refuses two handlers with one name", () => {
    /* Whichever loaded last would silently win, and every job queued for the
       other would run the wrong code. */
    expect(() =>
      outbox.buildRegistry([spy("email", { ok: true }).handler, spy("email", { ok: true }).handler])
    ).toThrow(/Duplicate outbox handler/);
  });

  it("ROLLS BACK with the change that promised it", async () => {
    /*
       The property the whole table exists for.

       A job queued inside a transaction that then fails must not survive it —
       otherwise the outbox promises work for a change that never happened,
       which is the same divergence it was built to prevent, pointing the
       other way.
    */
    const registry = outbox.buildRegistry([spy("email", { ok: true }).handler]);
    await expect(
      inA(async (q) => {
        await outbox.queueJob(q, registry, { handler: "email", payload: { documentId: "d1" } });
        throw new Error("the change failed after queueing");
      })
    ).rejects.toThrow();

    const left = await inA((q) => repo.pendingCount(q));
    expect(left).toBe(0);
  });

  it("treats a second enqueue under one dedupe key as the same job", async () => {
    /* A double-pressed button, a redelivered webhook and a replayed call all
       arrive as this. Two rows would be two emails. */
    const registry = outbox.buildRegistry([spy("email", { ok: true }).handler]);
    const first = await inA((q) =>
      outbox.queueJob(q, registry, { handler: "email", payload: { documentId: "d1" }, dedupeKey: "quote:d1" })
    );
    const second = await inA((q) =>
      outbox.queueJob(q, registry, { handler: "email", payload: { documentId: "d1" }, dedupeKey: "quote:d1" })
    );

    expect(second).toBe(first);
    expect(await inA((q) => repo.pendingCount(q))).toBe(1);
  });

  it("REVIVES a job that was given up on, when it is queued again", async () => {
    /*
       Without this the dedupe key turns a retry into a no-op, for ever: a
       person pressing Send again on a quotation that failed would collide with
       the dead row, be told the job is queued, and watch nothing happen.
       Queueing is a request for the work to HAPPEN.
    */
    const { handler } = spy("email", { ok: false, retry: false, error: "provider refused" });
    const registry = outbox.buildRegistry([handler]);
    await inA((q) =>
      outbox.queueJob(q, registry, { handler: "email", payload: {}, dedupeKey: "quote:d1" })
    );
    await outbox.drain(CTX_A, registry);
    expect(await inA((q) => repo.deadJobs(q))).toHaveLength(1);

    await inA((q) =>
      outbox.queueJob(q, registry, { handler: "email", payload: {}, dedupeKey: "quote:d1" })
    );
    const revived = await inA((q) => repo.findJob(q, "email", "quote:d1"));
    expect(revived?.status).toBe("pending");
    expect(revived?.attempts, "a revived job starts its ladder again").toBe(0);
    expect(revived?.lastError).toBeNull();
  });

  it("NEVER revives a job that finished", async () => {
    /* The dangerous half of the same rule. Reviving a completed send would
       email the client a second copy of their quotation. */
    const { handler, calls } = spy("email", { ok: true });
    const registry = outbox.buildRegistry([handler]);
    await inA((q) =>
      outbox.queueJob(q, registry, { handler: "email", payload: {}, dedupeKey: "quote:d1" })
    );
    await outbox.drain(CTX_A, registry);

    await inA((q) =>
      outbox.queueJob(q, registry, { handler: "email", payload: {}, dedupeKey: "quote:d1" })
    );
    expect((await inA((q) => repo.findJob(q, "email", "quote:d1")))?.status).toBe("done");
    expect(await outbox.drain(CTX_A, registry)).toMatchObject({ ran: 0 });
    expect(calls).toHaveLength(1);
  });

  it("does not reset a waiting job's backoff, however often it is queued", async () => {
    /* Otherwise a person pressing Send repeatedly would drive the retry ladder
       back to zero each time and hammer a provider that is already struggling. */
    const { handler } = spy("email", { ok: false, retry: true, error: "down" });
    const registry = outbox.buildRegistry([handler]);
    await inA((q) =>
      outbox.queueJob(q, registry, { handler: "email", payload: {}, dedupeKey: "quote:d1" })
    );
    await outbox.drain(CTX_A, registry);

    await inA((q) =>
      outbox.queueJob(q, registry, { handler: "email", payload: {}, dedupeKey: "quote:d1" })
    );
    const job = await inA((q) => repo.findJob(q, "email", "quote:d1"));
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toMatch(/down/);
    expect(await outbox.drain(CTX_A, registry), "still backed off").toMatchObject({ ran: 0 });
  });

  it("keeps jobs with no dedupe key distinct", async () => {
    /* Most jobs have no natural key. If NULLs collided, a workspace could
       queue one analysis and never a second. */
    const registry = outbox.buildRegistry([spy("email", { ok: true }).handler]);
    await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: { a: "1" } }));
    await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: { a: "2" } }));
    expect(await inA((q) => repo.pendingCount(q))).toBe(2);
  });

  it("lets two workspaces use the same dedupe key", async () => {
    /* The key is unique WITHIN a workspace. Shared globally, one customer's
       queued email would silently cancel another's. */
    const registry = outbox.buildRegistry([spy("email", { ok: true }).handler]);
    await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: {}, dedupeKey: "k" }));
    await inB((q) => outbox.queueJob(q, registry, { handler: "email", payload: {}, dedupeKey: "k" }));
    expect(await inA((q) => repo.pendingCount(q))).toBe(1);
    expect(await inB((q) => repo.pendingCount(q))).toBe(1);
  });
});

describe("claiming", () => {
  it("stamps the attempt and pushes the job out of reach", async () => {
    /*
       Claiming COMMITS the attempt before the work starts. That is what makes
       a crashed worker survivable: were the attempt part of the same
       transaction as the work, a job that killed the process would roll its
       own attempt back and be due again instantly — retrying for ever at full
       speed, which is the one failure a retry ladder exists to prevent.
    */
    const registry = outbox.buildRegistry([spy("email", { ok: true }).handler]);
    const id = await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: {} }));

    const claimed = await inA((q) => repo.claim(q, 10));
    expect(claimed.map((c) => c.id)).toEqual([id]);
    expect(claimed[0].attempts).toBe(1);

    // Leased: a second worker arriving now sees nothing to do.
    expect(await inA((q) => repo.claim(q, 10))).toEqual([]);
    const row = await rowOf(id);
    expect(row?.status).toBe("pending");
    expect(row?.due).toBe(false);
  });

  it("never hands one workspace another's work", async () => {
    const registry = outbox.buildRegistry([spy("email", { ok: true }).handler]);
    await inB((q) => outbox.queueJob(q, registry, { handler: "email", payload: {} }));
    expect(await inA((q) => repo.claim(q, 10))).toEqual([]);
    expect(await inB((q) => repo.claim(q, 10))).toHaveLength(1);
  });

  it("takes no more than it was asked for", async () => {
    /* The bound is what stops a serverless invocation being killed mid-pass
       with its leases held and its report lost. */
    const registry = outbox.buildRegistry([spy("email", { ok: true }).handler]);
    for (let i = 0; i < 5; i++) {
      await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: { i: String(i) } }));
    }
    expect(await inA((q) => repo.claim(q, 2))).toHaveLength(2);
  });
});

describe("what a result means", () => {
  it("stops when the handler says this will never work", () => {
    /* A refused address will be refused for ever. Six goes over two hours only
       delays the moment somebody finds out. */
    expect(outbox.decide({ ok: false, retry: false, error: "invalid address" }, 1)).toMatchObject({
      status: "dead",
    });
  });

  it("stops after the last attempt even for a retryable failure", () => {
    expect(outbox.decide({ ok: false, retry: true, error: "timeout" }, outbox.MAX_ATTEMPTS)).toMatchObject({
      status: "dead",
    });
    expect(
      outbox.decide({ ok: false, retry: true, error: "timeout" }, outbox.MAX_ATTEMPTS - 1)
    ).toMatchObject({ status: "retried" });
  });

  it("waits longer each time, and never for ever", () => {
    const waits = [1, 2, 3, 4, 5, 6].map(outbox.backoffSeconds);
    for (let i = 1; i < waits.length; i++) {
      expect(waits[i], `attempt ${i + 1} must not come sooner than attempt ${i}`).toBeGreaterThanOrEqual(
        waits[i - 1]
      );
    }
    expect(waits[0]).toBeGreaterThan(0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(3600);
  });
});

describe("draining", () => {
  it("runs the job, settles it, and does not run it again", async () => {
    const { handler, calls } = spy("email", { ok: true });
    const registry = outbox.buildRegistry([handler]);
    const id = await inA((q) =>
      outbox.queueJob(q, registry, { handler: "email", payload: { documentId: "d1" } })
    );

    expect(await outbox.drain(CTX_A, registry)).toMatchObject({ ran: 1, done: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toEqual({ documentId: "d1" });
    expect((await rowOf(id))?.status).toBe("done");

    expect(await outbox.drain(CTX_A, registry)).toMatchObject({ ran: 0 });
    expect(calls).toHaveLength(1);
  });

  it("hands the handler the job id, so it can be idempotent at the far end", async () => {
    /* Delivery is at least once. The only way an external send can be exactly
       once is a key the provider recognises — stable across retries of this
       job, different for every other. */
    const { handler, calls } = spy("email", { ok: true });
    const registry = outbox.buildRegistry([handler]);
    const id = await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: {} }));
    await outbox.drain(CTX_A, registry);
    expect(calls[0].id).toBe(id);
  });

  it("keeps a retryable failure, with the reason, for another go", async () => {
    const { handler } = spy("email", { ok: false, retry: true, error: "mail server unreachable" });
    const registry = outbox.buildRegistry([handler]);
    const id = await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: {} }));

    expect(await outbox.drain(CTX_A, registry)).toMatchObject({ ran: 1, retried: 1 });
    const row = await rowOf(id);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toMatch(/unreachable/);
    // Backed off, not immediately due — otherwise a broken provider is hammered.
    expect(row?.due).toBe(false);
  });

  it("treats a THROWN failure as unknown, and unknown as worth retrying", async () => {
    /* Giving up on a fault nobody has classified is how a transient bug
       becomes a lost email. */
    const handler: OutboxHandler = {
      name: "email",
      run: async () => {
        throw new Error("socket hang up");
      },
    };
    const registry = outbox.buildRegistry([handler]);
    const id = await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: {} }));

    expect(await outbox.drain(CTX_A, registry)).toMatchObject({ retried: 1 });
    expect((await rowOf(id))?.last_error).toMatch(/socket hang up/);
  });

  it("SETTLES a job whose handler wrote to the database and then failed", async () => {
    /*
       The settle runs in its own transaction on purpose. Written inside the
       handler's, it would roll back with it — and the job would look untried
       for ever, spending no attempts and never dying.
    */
    const handler: OutboxHandler = {
      name: "email",
      run: async (_payload, job) => {
        await withTenant(job.ctx, (q) => q.rows(`SELECT 1`));
        throw new Error("failed after writing");
      },
    };
    const registry = outbox.buildRegistry([handler]);
    const id = await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: {} }));

    await outbox.drain(CTX_A, registry);
    const row = await rowOf(id);
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toMatch(/failed after writing/);
  });

  it("gives up after the ceiling, and says why in a row somebody can find", async () => {
    /* A dead row STAYS in the table. A job that vanishes is a job nobody
       fixes, and the person it mattered to never learns it did not happen. */
    const { handler } = spy("email", { ok: false, retry: true, error: "still down" });
    const registry = outbox.buildRegistry([handler]);
    const id = await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: {} }));

    for (let i = 0; i < outbox.MAX_ATTEMPTS; i++) {
      // Undo the backoff so the ladder can be walked without waiting hours.
      await db.seed(`UPDATE outbox SET run_after = now() - interval '1 second'`);
      await outbox.drain(CTX_A, registry);
    }

    const row = await rowOf(id);
    expect(row?.status).toBe("dead");
    expect(row?.attempts).toBe(outbox.MAX_ATTEMPTS);
    expect(row?.last_error).toMatch(/still down/);

    const dead = await inA((q) => repo.deadJobs(q));
    expect(dead.map((d) => d.id)).toContain(id);
  });

  it("gives up at once on a failure the handler calls permanent", async () => {
    const { handler, calls } = spy("email", { ok: false, retry: false, error: "no such address" });
    const registry = outbox.buildRegistry([handler]);
    const id = await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: {} }));

    expect(await outbox.drain(CTX_A, registry)).toMatchObject({ dead: 1 });
    expect((await rowOf(id))?.status).toBe("dead");
    expect(calls).toHaveLength(1);
  });

  it("keeps a job whose handler this deployment does not have", async () => {
    /*
       A rollback: the code that queued the work is briefly gone. Dropping the
       job would destroy work the previous deployment promised; running it is
       impossible. So it waits — and still counts attempts, so a name that
       never comes back eventually dies rather than waiting for ever.
    */
    const registry = outbox.buildRegistry([spy("email", { ok: true }).handler]);
    const id = await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: {} }));
    await db.seed(`UPDATE outbox SET handler = 'from_a_newer_deployment'`);

    expect(await outbox.drain(CTX_A, registry)).toMatchObject({ ran: 1, retried: 1 });
    const row = await rowOf(id);
    expect(row?.status).toBe("pending");
    expect(row?.last_error).toMatch(/No handler named from_a_newer_deployment/);
  });

  it("carries on through a queue when one job fails", async () => {
    /* One bad job must not strand the ones behind it. */
    let n = 0;
    const handler: OutboxHandler = {
      name: "email",
      run: async () => (++n === 1 ? { ok: false, retry: true, error: "first one failed" } : { ok: true }),
    };
    const registry = outbox.buildRegistry([handler]);
    for (let i = 0; i < 3; i++) {
      await inA((q) => outbox.queueJob(q, registry, { handler: "email", payload: { i: String(i) } }));
    }
    expect(await outbox.drain(CTX_A, registry)).toMatchObject({ ran: 3, done: 2, retried: 1 });
  });

  it("does not run another workspace's jobs", async () => {
    const { handler, calls } = spy("email", { ok: true });
    const registry = outbox.buildRegistry([handler]);
    await inB((q) => outbox.queueJob(q, registry, { handler: "email", payload: { tenant: "B" } }));

    expect(await outbox.drain(CTX_A, registry)).toMatchObject({ ran: 0 });
    expect(calls).toHaveLength(0);
  });
});
