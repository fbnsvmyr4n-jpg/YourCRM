import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The scheduled drain, driven as an HTTP request.
 *
 * This endpoint's URL is public and it makes the platform send mail, so the
 * shared secret is the whole of its protection — which is why it is tested by
 * calling it rather than by reading it. The case that matters most is the one
 * that looks like a configuration slip: **no secret set at all.** An endpoint
 * that fell back to running openly would make a forgotten environment variable
 * indistinguishable from a configured one, and the difference is an
 * unauthenticated way to flush every workspace's queue on demand.
 *
 * The sweep beneath it is also proven here to be genuinely cross-workspace,
 * because that is the only reason this endpoint exists: a request can drain
 * its own workspace, and nothing else can.
 */

const SECRET = "cron-secret-for-the-test";
const ROUTE = "src/app/api/tasks/drain/route.ts";

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let outbox: typeof import("../src/server/outbox");
let route: typeof import("../src/app/api/tasks/drain/route");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});

const request = (auth?: string) =>
  new Request("https://crm.test/api/tasks/drain", {
    method: "POST",
    headers: auth === undefined ? {} : { authorization: auth },
  });

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  outbox = await import("../src/server/outbox");
  route = await import("../src/app/api/tasks/drain/route");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  process.env.CRON_SECRET = SECRET;
  await db.seed(`DELETE FROM outbox;`);
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("who may run the drain", () => {
  it("REFUSES when no secret is configured, rather than running openly", async () => {
    /* The failure this is really guarding against. Defaulting to open would
       turn one forgotten environment variable into an unauthenticated way to
       make the platform send every queued email. */
    delete process.env.CRON_SECRET;
    for (const header of [undefined, "Bearer anything", "Bearer "]) {
      expect((await route.POST(request(header))).status, `header: ${header}`).toBe(401);
    }
  });

  it("refuses a caller with no credentials, or the wrong ones", async () => {
    expect((await route.POST(request())).status).toBe(401);
    expect((await route.POST(request("Bearer wrong"))).status).toBe(401);
    // A prefix of the real secret, which a `startsWith` would have let through.
    expect((await route.POST(request(`Bearer ${SECRET.slice(0, -1)}`))).status).toBe(401);
  });

  it("accepts the secret, with or without the Bearer prefix", async () => {
    expect((await route.POST(request(`Bearer ${SECRET}`))).status).toBe(200);
    expect((await route.POST(request(SECRET))).status).toBe(200);
  });

  it("answers a GET the same way, because that is what a cron trigger sends", async () => {
    expect((await route.GET(request(`Bearer ${SECRET}`))).status).toBe(200);
    expect((await route.GET(request("Bearer wrong"))).status).toBe(401);
  });

  it("says the same thing whether the secret is wrong or missing", async () => {
    /* Which of the two it is tells an unauthenticated caller something about
       this deployment's configuration. */
    const wrong = await route.POST(request("Bearer wrong"));
    delete process.env.CRON_SECRET;
    const missing = await route.POST(request("Bearer wrong"));
    expect(await wrong.text()).toBe(await missing.text());
    expect(wrong.status).toBe(missing.status);
  });

  it("compares in constant time", () => {
    /* Not observable from a response, so it is read. `===` on a secret leaks
       its length and prefix to anybody willing to time the answers. */
    const src = readFileSync(ROUTE, "utf8");
    expect(src, "the secret is not compared in constant time").toMatch(/timingSafeEqual\(/);
  });
});

describe("what the drain reaches", () => {
  it("runs work belonging to a workspace nobody is signed in to", async () => {
    /*
       The whole reason this endpoint exists. Every other drain in the app is
       opportunistic — it happens inside a request, and can only ever see that
       request's workspace. A job whose request has ended is reachable from
       nowhere else.
    */
    let ran = 0;
    const registry = outbox.buildRegistry([
      { name: "email", run: async () => ((ran += 1), { ok: true }) },
    ]);
    await withTenant(ctxFor(TENANT_A), (q) =>
      outbox.queueJob(q, registry, { handler: "email", payload: {} })
    );

    const res = await route.POST(request(`Bearer ${SECRET}`));
    const report = await res.json();

    expect(report.workspaces).toBeGreaterThan(0);
    /* The real registry ran it, not the test's — which is the point: the
       endpoint must reach the handlers the app actually ships. The job names
       `email`, which is not one of them, so it is kept for a later deployment
       rather than dropped. */
    expect(report.ran).toBe(1);
    expect(report.retried).toBe(1);
    expect(ran).toBe(0);
  });

  it("reports counts and nothing else", async () => {
    /* What is in a workspace's queue is between that workspace and its own
       screens. This answers "did the sweep run, did anything fail". */
    const res = await route.POST(request(`Bearer ${SECRET}`));
    expect(Object.keys(await res.json()).sort()).toEqual([
      "dead",
      "done",
      "ran",
      "retried",
      "workspaces",
    ]);
  });
});
