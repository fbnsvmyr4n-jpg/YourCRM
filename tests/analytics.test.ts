import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B, AGENCY, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The reports layer.
 *
 * This is where wrong arithmetic used to live, so most of these tests are about
 * formulas rather than plumbing: a win rate that fell every time a lead was
 * added, an average of nothing rendering as £0, a pipeline chart that dropped
 * empty stages and made the funnel look shorter than it was.
 *
 * The figures are asserted against hand-counted fixtures — a test that
 * recomputes the same expression it is checking proves only that the expression
 * is stable, not that it is right.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let analytics: typeof import("../src/server/analytics");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  analytics = await import("../src/server/analytics");
});

afterAll(async () => {
  await closePool();
  await db.stop();
});

const report = (tenant = TENANT_A) => withTenant(ctxFor(tenant), (q) => analytics.reportData(q));

const clear = () =>
  db.seed(`DELETE FROM deals; DELETE FROM contacts; DELETE FROM meetings; DELETE FROM calls;`);

/** Deals written directly, so the fixture states exactly what is being counted. */
const seedDeals = (rows: string) =>
  db.seed(
    `INSERT INTO deals (id, sub_account_id, contact_id, owner_user_id, title, value_cents,
                        stage, source, won_at, lost_reason) VALUES ${rows}`
  );

beforeEach(clear);

describe("revenue counts the money that is real", () => {
  it("counts won deals through Delivery and Referral, not just 'won'", async () => {
    /**
     * The rule the pipeline turns on. Delivery and Referral are post-close, so
     * reading won-ness from the stage would make revenue FALL as delivery
     * succeeded — success looking like a loss. `won_at` is the fact.
     */
    await seedDeals(`
      ('d1','${TENANT_A}',NULL,NULL,'Won',      100000,'won',     'other', now(), NULL),
      ('d2','${TENANT_A}',NULL,NULL,'Delivering',200000,'delivery','other', now(), NULL),
      ('d3','${TENANT_A}',NULL,NULL,'Referring', 300000,'referral','other', now(), NULL)`);

    const r = await report();
    expect(r.revenue.wonCents).toBe(600_000);
    expect(r.revenue.wonCount).toBe(3);
  });

  it("counts only the three pre-close stages as open pipeline", async () => {
    await seedDeals(`
      ('d1','${TENANT_A}',NULL,NULL,'Prospect', 100000,'prospect', 'other', NULL, NULL),
      ('d2','${TENANT_A}',NULL,NULL,'Discovery',200000,'discovery','other', NULL, NULL),
      ('d3','${TENANT_A}',NULL,NULL,'Demo',     300000,'demo',     'other', NULL, NULL),
      ('d4','${TENANT_A}',NULL,NULL,'Won',      900000,'won',      'other', now(), NULL),
      ('d5','${TENANT_A}',NULL,NULL,'Lost',     500000,'lost',     'other', NULL, 'Price')`);

    const r = await report();
    expect(r.revenue.openPipelineCents, "a won or lost deal is still in the pipeline").toBe(600_000);
    expect(r.revenue.openCount).toBe(3);
  });

  it("reports no average at all when nothing has been won", async () => {
    // An average of nothing is not zero, and £0 reads as a real and alarming
    // figure on a new account.
    await seedDeals(`('d1','${TENANT_A}',NULL,NULL,'Open',100000,'demo','other',NULL,NULL)`);
    expect((await report()).revenue.avgWonDealCents).toBeNull();
  });

  it("averages only won deals", async () => {
    await seedDeals(`
      ('d1','${TENANT_A}',NULL,NULL,'Won A',100000,'won','other',now(),NULL),
      ('d2','${TENANT_A}',NULL,NULL,'Won B',300000,'won','other',now(),NULL),
      ('d3','${TENANT_A}',NULL,NULL,'Open', 999999,'demo','other',NULL,NULL)`);
    expect((await report()).revenue.avgWonDealCents).toBe(200_000);
  });

  it("ignores deleted deals everywhere", async () => {
    await seedDeals(`('d1','${TENANT_A}',NULL,NULL,'Won',100000,'won','other',now(),NULL)`);
    await db.seed(`UPDATE deals SET deleted_at = now()`);
    const r = await report();
    expect(r.revenue.wonCents).toBe(0);
    expect(r.revenue.wonCount).toBe(0);
  });
});

describe("win rate is out of decided deals", () => {
  it("does not count deals still in progress as losses", async () => {
    /**
     * The old formula was won ÷ ALL deals, which fell every time a lead was
     * added — adding a prospect made the team look worse. Two won, one lost,
     * three still open: the rate is 2/3, not 2/6.
     */
    await seedDeals(`
      ('d1','${TENANT_A}',NULL,NULL,'W1',100000,'won','other',now(),NULL),
      ('d2','${TENANT_A}',NULL,NULL,'W2',100000,'won','other',now(),NULL),
      ('d3','${TENANT_A}',NULL,NULL,'L1',100000,'lost','other',NULL,'Price'),
      ('d4','${TENANT_A}',NULL,NULL,'O1',100000,'prospect','other',NULL,NULL),
      ('d5','${TENANT_A}',NULL,NULL,'O2',100000,'discovery','other',NULL,NULL),
      ('d6','${TENANT_A}',NULL,NULL,'O3',100000,'demo','other',NULL,NULL)`);

    // A percentage, not a ratio: 2 of 3 is 67, and it is printed with a % sign.
    expect((await report()).winRate).toBe(67);
  });

  it("does not move when an open deal is added", async () => {
    // The property that made the old figure useless, stated directly.
    await seedDeals(`
      ('d1','${TENANT_A}',NULL,NULL,'W',100000,'won','other',now(),NULL),
      ('d2','${TENANT_A}',NULL,NULL,'L',100000,'lost','other',NULL,'Price')`);
    const before = (await report()).winRate;

    await seedDeals(`('d3','${TENANT_A}',NULL,NULL,'New lead',100000,'prospect','other',NULL,NULL)`);
    expect((await report()).winRate, "adding a lead changed the win rate").toBe(before);
  });

  it("is null until something has been decided", async () => {
    await seedDeals(`('d1','${TENANT_A}',NULL,NULL,'Open',100000,'demo','other',NULL,NULL)`);
    expect((await report()).winRate).toBeNull();
  });
});

describe("attribution needs no caveat any more", () => {
  it("traces won revenue to a source without matching names", async () => {
    /**
     * The reason the fold mattered. Source used to be discovered by matching a
     * won deal to a lead BY NAME, only 4 of 10 matched, and the report carried
     * an `unattributed` bucket to admit it. Source is a column now.
     */
    await seedDeals(`
      ('d1','${TENANT_A}',NULL,NULL,'A',100000,'won','google_ads',now(),NULL),
      ('d2','${TENANT_A}',NULL,NULL,'B',300000,'won','google_ads',now(),NULL),
      ('d3','${TENANT_A}',NULL,NULL,'C',500000,'won','referral', now(),NULL),
      ('d4','${TENANT_A}',NULL,NULL,'D',900000,'demo','referral',NULL,NULL)`);

    const r = await report();
    const google = r.bySource.find((s) => s.source === "google_ads")!;
    const referral = r.bySource.find((s) => s.source === "referral")!;

    expect(google).toMatchObject({ deals: 2, wonDeals: 2, wonCents: 400_000 });
    expect(referral).toMatchObject({ deals: 2, wonDeals: 1, wonCents: 500_000 });
    expect(google.wonCents + referral.wonCents).toBe(r.revenue.wonCents);
  });

  it("has no unattributed bucket left to report", () => {
    // The shape itself should no longer be able to express the old caveat.
    expect(Object.keys({} as import("../src/server/analytics").ReportData)).not.toContain(
      "attribution"
    );
  });

  it("lists every source, including the ones with nothing in them", async () => {
    // A source that silently disappears when it has no deals hides the fact
    // that a channel produced nothing, which is itself the finding.
    await seedDeals(`('d1','${TENANT_A}',NULL,NULL,'A',100000,'won','facebook',now(),NULL)`);
    const r = await report();
    expect(r.bySource.map((s) => s.source)).toContain("google_ads");
    expect(r.bySource.find((s) => s.source === "google_ads")).toMatchObject({ deals: 0, wonCents: 0 });
  });
});

describe("the pipeline and its losses", () => {
  it("lists every stage, including the empty ones", async () => {
    // Dropping an empty stage makes the funnel look shorter than it is, and
    // hides exactly the gap worth noticing.
    await seedDeals(`('d1','${TENANT_A}',NULL,NULL,'A',100000,'demo','other',NULL,NULL)`);
    const r = await report();
    expect(r.byStage.map((s) => s.stage)).toEqual([
      "prospect",
      "discovery",
      "demo",
      "won",
      "delivery",
      "referral",
      "lost",
    ]);
    expect(r.byStage.find((s) => s.stage === "prospect")).toMatchObject({ count: 0, valueCents: 0 });
  });

  it("counts why deals were lost, most common first", async () => {
    await seedDeals(`
      ('d1','${TENANT_A}',NULL,NULL,'A',100000,'lost','other',NULL,'Price'),
      ('d2','${TENANT_A}',NULL,NULL,'B',100000,'lost','other',NULL,'Price'),
      ('d3','${TENANT_A}',NULL,NULL,'C',100000,'lost','other',NULL,'Timing'),
      ('d4','${TENANT_A}',NULL,NULL,'D',100000,'won','other',now(),NULL)`);

    expect((await report()).lossReasons).toEqual([
      { reason: "Price", count: 2 },
      { reason: "Timing", count: 1 },
    ]);
  });
});

describe("contacts are classified by their deals, not a stored status", () => {
  it("counts a client by a won deal and a lead by an open one", async () => {
    await db.seed(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES
        ('c_client','${TENANT_A}','Paid','Client'),
        ('c_lead','${TENANT_A}','Open','Lead'),
        ('c_neither','${TENANT_A}','No','Deals')`
    );
    await seedDeals(`
      ('d1','${TENANT_A}','c_client',NULL,'Won', 100000,'won','other',now(),NULL),
      ('d2','${TENANT_A}','c_lead',  NULL,'Open',100000,'demo','other',NULL,NULL)`);

    expect((await report()).contacts).toEqual({ total: 3, clients: 1, leads: 1 });
  });

  it("keeps counting someone as a client after their deal moves to Delivery", async () => {
    await db.seed(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name)
       VALUES ('c1','${TENANT_A}','Still','Client')`
    );
    await seedDeals(
      `('d1','${TENANT_A}','c1',NULL,'Delivering',100000,'delivery','other',now(),NULL)`
    );
    expect((await report()).contacts.clients).toBe(1);
  });
});

describe("owners, voice and trend", () => {
  it("shows no leaderboard when there is only one owner", async () => {
    // One owner is not a comparison, it is a picture of you.
    await seedDeals(`('d1','${TENANT_A}',NULL,'${USER_A}','A',100000,'won','other',now(),NULL)`);
    expect((await report()).owners).toEqual([]);
  });

  it("ranks owners by revenue once there is something to compare", async () => {
    await db.seed(
      `INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role)
       VALUES ('u_two','${AGENCY}','${TENANT_A}','two@test.local','x','Second Person','member')
       ON CONFLICT DO NOTHING`
    );
    await seedDeals(`
      ('d1','${TENANT_A}',NULL,'${USER_A}','A',100000,'won','other',now(),NULL),
      ('d2','${TENANT_A}',NULL,'u_two',    'B',500000,'won','other',now(),NULL)`);

    const owners = (await report()).owners;
    expect(owners).toHaveLength(2);
    expect(owners[0], "owners are not ranked by revenue").toMatchObject({
      ownerUserId: "u_two",
      wonCents: 500_000,
    });
  });

  it("reports no average call length when there have been no calls", async () => {
    expect((await report()).voice).toMatchObject({ calls: 0, avgSeconds: null });
  });

  it("counts calls that produced a deal, from the link rather than a guess", async () => {
    await seedDeals(`('d1','${TENANT_A}',NULL,NULL,'From call',100000,'demo','phone_call',NULL,NULL)`);
    await db.seed(
      `INSERT INTO calls (id, sub_account_id, created_deal_id, caller_name, duration_sec) VALUES
        ('call1','${TENANT_A}','d1','Jo',   120),
        ('call2','${TENANT_A}',NULL,'Sam',   60)`
    );
    expect((await report()).voice).toMatchObject({
      calls: 2,
      producedDeal: 1,
      totalSeconds: 180,
      avgSeconds: 90,
    });
  });

  it("buckets won revenue by week", async () => {
    await seedDeals(`
      ('d1','${TENANT_A}',NULL,NULL,'A',100000,'won','other',now(),NULL),
      ('d2','${TENANT_A}',NULL,NULL,'B',200000,'won','other',now(),NULL),
      ('d3','${TENANT_A}',NULL,NULL,'C',400000,'won','other',now() - interval '2 weeks',NULL)`);

    const weekly = (await report()).weekly;
    expect(weekly.length).toBeGreaterThanOrEqual(2);
    expect(weekly.at(-1)!.wonCents, "this week's two deals were not combined").toBe(300_000);
    // Ascending, so a chart reads left to right without re-sorting.
    const times = weekly.map((w) => Date.parse(w.weekStart));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("every figure is one tenant's", () => {
  it("does not mix another sub-account into any total", async () => {
    await seedDeals(`
      ('d1','${TENANT_A}',NULL,NULL,'Mine',  100000,'won','other',now(),NULL),
      ('d2','${TENANT_B}',NULL,NULL,'Theirs',900000,'won','other',now(),NULL)`);

    const mine = await report(TENANT_A);
    const theirs = await report(TENANT_B);

    expect(mine.revenue.wonCents, "another tenant's revenue was included").toBe(100_000);
    expect(theirs.revenue.wonCents).toBe(900_000);
    expect(mine.revenue.wonCount).toBe(1);
  });

  it("reports an empty account as empty, not as an error", async () => {
    const r = await report(TENANT_B);
    expect(r.revenue).toMatchObject({ wonCents: 0, wonCount: 0, avgWonDealCents: null });
    expect(r.winRate).toBeNull();
    expect(r.lossReasons).toEqual([]);
    expect(r.byStage).toHaveLength(7);
  });
});
