import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import { ENOUGH, oddsFrom, weightedPipeline, FORECAST_STAGES } from "../src/server/stage-odds";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * How likely a deal at a given stage is to close, measured rather than assigned.
 *
 * The pipeline board said what each stage was WORTH and never what any of it
 * was likely to be. The figure has to come from this workspace's own closed
 * deals, and the trap is the deals whose route nobody recorded: filling those
 * in from the stage they happen to sit in now would make every already-won
 * deal look as though it reached `won` without ever passing through Demo, and
 * Demo would read a confident, precise, fabricated 0%.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let stageOdds: typeof import("../src/server/stage-odds").stageOdds;
let moveStage: typeof import("../src/server/repos/deals").moveStage;
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);
const rateFor = (odds: { stage: string; winRate: number | null }[], stage: string) =>
  odds.find((o) => o.stage === stage)!.winRate;

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  ({ stageOdds } = await import("../src/server/stage-odds"));
  ({ moveStage } = await import("../src/server/repos/deals"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM deals;`));

/** A closed deal with a recorded route. `won` decides the outcome. */
const deal = (id: string, route: string[], won: boolean, tenant = TENANT_A) => `
  INSERT INTO deals (id, sub_account_id, title, value_cents, stage, source, won_at, lost_at, lost_reason, stages_reached)
  VALUES ('${id}', '${tenant}', '${id}', 1000, '${won ? "won" : "lost"}', 'website',
          ${won ? "now()" : "NULL"}, ${won ? "NULL" : "now()"}, ${won ? "NULL" : "'price'"},
          ARRAY[${route.map((s) => `'${s}'`).join(",")}]);`;

/** Enough closed deals through a stage for a rate to be allowed at all. */
const manyThrough = (stage: string, won: number, lost: number) =>
  [
    ...Array.from({ length: won }, (_, i) => deal(`w_${stage}_${i}`, ["prospect", stage, "won"], true)),
    ...Array.from({ length: lost }, (_, i) => deal(`l_${stage}_${i}`, ["prospect", stage], false)),
  ].join("\n");

describe("the arithmetic", () => {
  it("is a real division, out of the deals that reached the stage", () => {
    const odds = oddsFrom([{ stage: "demo", decided: 8, won: 6 }]);
    expect(rateFor(odds, "demo")).toBe(75);
  });

  it("SAYS NOTHING RATHER THAN 0% when there is not enough history", () => {
    /* Null, never zero: "no data" and "never wins" are different claims. */
    const odds = oddsFrom([{ stage: "demo", decided: ENOUGH - 1, won: 0 }]);
    expect(rateFor(odds, "demo")).toBe(null);
  });

  it("reports every stage, including the ones nothing has reached", () => {
    const odds = oddsFrom([]);
    expect(odds.length).toBeGreaterThan(4);
    expect(odds.every((o) => o.winRate === null && o.decided === 0)).toBe(true);
  });

  it("forecasts only the stages a deal can still go either way from", () => {
    expect(FORECAST_STAGES).not.toContain("won");
    expect(FORECAST_STAGES).not.toContain("lost");
    expect(FORECAST_STAGES).not.toContain("delivery");
    expect(FORECAST_STAGES).toContain("demo");
  });
});

describe("the weighted pipeline", () => {
  const odds = oddsFrom([
    { stage: "demo", decided: 10, won: 5 },
    { stage: "discovery", decided: 10, won: 2 },
  ]);

  it("weights each deal by how deals at its stage have actually gone", () => {
    const { weightedCents } = weightedPipeline(
      [
        { stage: "demo", valueCents: 100_000 },
        { stage: "discovery", valueCents: 100_000 },
      ],
      odds
    );
    expect(weightedCents).toBe(50_000 + 20_000);
  });

  it("KEEPS WHAT IT CANNOT SPEAK FOR SEPARATE, rather than calling it zero", () => {
    /* A stage with no measured rate must not quietly drag the forecast down —
       nor be waved through as certain. It is reported as its own figure. */
    const { weightedCents, unweightedCents } = weightedPipeline(
      [
        { stage: "demo", valueCents: 100_000 },
        { stage: "prospect", valueCents: 80_000 },
      ],
      odds
    );
    expect(weightedCents).toBe(50_000);
    expect(unweightedCents).toBe(80_000);
  });
});

describe("what the database counts", () => {
  it("A DEAL WHOSE ROUTE WAS NEVER RECORDED IS NOT COUNTED", async () => {
    /* The whole point. These are the deals that existed before the column did:
       filling them in from their current stage is the fabrication this guards
       against, so an untracked deal contributes to no stage at all. */
    await db.seed(`
      ${manyThrough("demo", 3, 3)}
      INSERT INTO deals (id, sub_account_id, title, value_cents, stage, source, won_at, stages_reached)
      VALUES ('legacy_won', '${TENANT_A}', 'Legacy', 5000, 'won', 'website', now(), NULL);
    `);
    const odds = await inA((q) => stageOdds(q));
    expect(odds.find((o) => o.stage === "demo")!.decided, "an untracked deal was counted").toBe(6);
    expect(rateFor(odds, "demo")).toBe(50);
  });

  it("counts a deal once for every stage its route reached", async () => {
    await db.seed(manyThrough("demo", 4, 2));
    const odds = await inA((q) => stageOdds(q));
    /* Every one of them went through prospect as well. */
    expect(odds.find((o) => o.stage === "prospect")!.decided).toBe(6);
    expect(rateFor(odds, "prospect")).toBe(67);
    expect(rateFor(odds, "demo")).toBe(67);
  });

  it("ignores deals that are still open — they have not gone either way", async () => {
    await db.seed(`
      ${manyThrough("demo", 3, 3)}
      INSERT INTO deals (id, sub_account_id, title, value_cents, stage, source, stages_reached)
      VALUES ('still_open', '${TENANT_A}', 'Open', 5000, 'demo', 'website', ARRAY['prospect','demo']);
    `);
    const odds = await inA((q) => stageOdds(q));
    expect(odds.find((o) => o.stage === "demo")!.decided).toBe(6);
  });

  it("A DEAL THAT WAS NEVER TRACKED STAYS UNTRACKED when it is moved", async () => {
    /* The other half of "not backfilled", and the one mutation testing found
       nothing was checking. Starting a route the first time a legacy deal is
       moved would claim the deal began at whatever stage it was moved to —
       so a deal that has been running for months would enter the maths as
       though its whole life were one step. */
    await db.seed(`
      INSERT INTO deals (id, sub_account_id, title, value_cents, stage, source, stages_reached)
      VALUES ('legacy_open', '${TENANT_A}', 'Legacy', 5000, 'discovery', 'website', NULL);
    `);
    await inA((q) => moveStage(q, "legacy_open", "demo"));
    const route = await inA((q) =>
      q.one<{ stages_reached: string[] | null }>(
        `SELECT stages_reached FROM deals WHERE id = 'legacy_open' AND sub_account_id = $1`,
        [TENANT_A]
      )
    );
    expect(route?.stages_reached, "a route was invented for a deal nobody was watching").toBe(null);
  });

  it("RECORDS A STAGE ONCE, however many times a deal goes back to it", async () => {
    /* Deals go backwards. "Of the deals that reached Demo" is a question about
       whether it got there, not how many times — counting a stage twice would
       weight one indecisive deal as two. */
    await db.seed(`
      INSERT INTO deals (id, sub_account_id, title, value_cents, stage, source, stages_reached)
      VALUES ('wobbler', '${TENANT_A}', 'Wobbler', 5000, 'discovery', 'website', ARRAY['discovery']);
    `);
    await inA(async (q) => {
      await moveStage(q, "wobbler", "demo");
      await moveStage(q, "wobbler", "discovery");
      await moveStage(q, "wobbler", "demo");
    });
    const route = await inA((q) =>
      q.one<{ stages_reached: string[] }>(
        `SELECT stages_reached FROM deals WHERE id = 'wobbler' AND sub_account_id = $1`,
        [TENANT_A]
      )
    );
    expect(route?.stages_reached).toEqual(["discovery", "demo"]);
  });

  it("never counts another workspace's deals", async () => {
    await db.seed(`
      ${manyThrough("demo", 3, 3)}
      ${deal("theirs_1", ["prospect", "demo", "won"], true, TENANT_B)}
      ${deal("theirs_2", ["prospect", "demo", "won"], true, TENANT_B)}
    `);
    const odds = await inA((q) => stageOdds(q));
    expect(odds.find((o) => o.stage === "demo")!.decided).toBe(6);
    expect(rateFor(odds, "demo")).toBe(50);
  });
});
