import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * The meetings funnel, when nothing has been decided yet.
 *
 * The first step's percentage was the literal 100 rather than a division, so a
 * workspace whose meetings had all simply not happened yet saw "Booked 0" with
 * "100% of booked" under it and a full-width bar beside it — a conversion rate
 * asserted out of nothing, on a card that says "From recorded outcomes" in its
 * own header. Found on 18 Sep 2026 driving the Meetings page against a fixture
 * with three scheduled meetings and no outcomes.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let meetingAnalytics: typeof import("../src/server/meeting-analytics").meetingAnalytics;
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);
const stepOf = (funnel: { label: string; value: number; pct: number }[], label: string) =>
  funnel.find((s) => s.label === label)!;

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  ({ meetingAnalytics } = await import("../src/server/meeting-analytics"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const seed = (outcomes: string[]) =>
  db.seed(`
    DELETE FROM meetings;
    INSERT INTO meetings (id, sub_account_id, topic, scheduled_at, duration_min, outcome) VALUES
      ${outcomes
        .map((o, i) => `('mt_${i}', '${TENANT_A}', 'Visit', now() - interval '1 day', 30, '${o}')`)
        .join(",\n      ")};
  `);

beforeEach(() => seed(["scheduled", "scheduled", "scheduled"]));

describe("the meetings funnel", () => {
  it("CLAIMS NOTHING WHEN NO OUTCOME HAS BEEN RECORDED — not 100% of nothing", async () => {
    const a = await inA((q) => meetingAnalytics(q));
    expect(a.decided).toBe(0);
    expect(stepOf(a.funnel, "Booked").value).toBe(0);
    expect(stepOf(a.funnel, "Booked").pct, "a full bar was drawn over an empty funnel").toBe(0);
  });

  it("still counts the meetings themselves, and says they are waiting", async () => {
    const a = await inA((q) => meetingAnalytics(q));
    expect(a.total).toBe(3);
    expect(a.pending).toBe(3);
    /* Null, not zero: "no data" and "0%" are different claims. */
    expect(a.showRate).toBe(null);
    expect(a.conversion).toBe(null);
  });

  it("is a real hundred percent once something has been decided", async () => {
    await seed(["won", "lost", "scheduled"]);
    const a = await inA((q) => meetingAnalytics(q));
    expect(stepOf(a.funnel, "Booked")).toEqual({ label: "Booked", value: 2, pct: 100 });
    expect(stepOf(a.funnel, "Closed won")).toEqual({ label: "Closed won", value: 1, pct: 50 });
  });
});
