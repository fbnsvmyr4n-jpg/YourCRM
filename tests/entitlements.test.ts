import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDb, AGENCY } from "./helpers/pg";

/**
 * What each plan grants, and when it stops granting it.
 *
 * The cases that matter are the ones where being wrong costs money in the
 * direction nobody notices. A lapsed trial that keeps working produces a happy
 * customer and no invoice — nothing errors, nothing alerts, and the only signal
 * is revenue that never arrives.
 *
 * The limits are checked against the seeded table rather than against numbers
 * repeated here, so the test cannot drift from the pricing.
 */

const SCHEMA = readFileSync(join(__dirname, "..", "src", "server", "schema.sql"), "utf8");

let db: TestDb;
let withSystem: typeof import("../src/server/tenant").withSystem;
let ent: typeof import("../src/server/entitlements");
let closePool: typeof import("../src/server/db").closePool;

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  ent = await import("../src/server/entitlements");
});

afterAll(async () => {
  await closePool();
  await db.stop();
});

const setPlan = (plan: string, status: string, trialEndsAt: string | null = null) =>
  db.seed(
    `UPDATE agencies SET plan = '${plan}', plan_status = '${status}',
       trial_ends_at = ${trialEndsAt ? `'${trialEndsAt}'::timestamptz` : "NULL"}
     WHERE id = '${AGENCY}'`
  );

const get = () => withSystem((q) => ent.entitlementsFor(q, AGENCY));

beforeEach(() => setPlan("starter", "active"));

describe("the plans grant what the pricing says", () => {
  it("Starter caps sub-accounts at three", async () => {
    const e = await get();
    expect(ent.can(e, "crm")).toBe(true);
    expect(ent.limitOf(e, "sub_accounts")).toBe(3);
    // Unlimited contacts and users are the headline of the $97 tier.
    expect(ent.limitOf(e, "contacts")).toBeNull();
    expect(ent.limitOf(e, "users")).toBeNull();
  });

  it("Starter does not include the things it does not sell", async () => {
    const e = await get();
    for (const feature of ["api_access", "white_label", "saas_mode", "rebilling"]) {
      expect(ent.can(e, feature), `Starter should not include ${feature}`).toBe(false);
    }
  });

  it("Unlimited lifts the sub-account cap and adds API and white label", async () => {
    await setPlan("unlimited", "active");
    const e = await get();
    expect(ent.limitOf(e, "sub_accounts"), "still capped").toBeNull();
    expect(ent.can(e, "api_access")).toBe(true);
    expect(ent.can(e, "white_label")).toBe(true);
    // But not the SaaS Pro features — that is what the next tier is for.
    expect(ent.can(e, "saas_mode")).toBe(false);
    expect(ent.can(e, "rebilling")).toBe(false);
  });

  it("SaaS Pro adds SaaS mode and rebilling", async () => {
    await setPlan("saas_pro", "active");
    const e = await get();
    expect(ent.can(e, "saas_mode")).toBe(true);
    expect(ent.can(e, "rebilling")).toBe(true);
  });

  it("each tier includes everything the one below it does", async () => {
    // Stated as a property rather than by listing features: a tier that
    // silently loses something on upgrade is a support ticket from somebody
    // who just paid more.
    const of = async (plan: string) => {
      await setPlan(plan, "active");
      return new Set((await get()).grants.keys());
    };
    const starter = await of("starter");
    const unlimited = await of("unlimited");
    const saasPro = await of("saas_pro");

    for (const f of starter) expect(unlimited.has(f), `Unlimited lost ${f}`).toBe(true);
    for (const f of unlimited) expect(saasPro.has(f), `SaaS Pro lost ${f}`).toBe(true);
  });

  it("a feature with no row is simply not granted", async () => {
    // No "enabled: false" anywhere — an absent grant and a disabled grant would
    // be two ways to say one thing, and they would eventually disagree.
    const e = await get();
    expect(ent.can(e, "time_travel")).toBe(false);
    expect(ent.limitOf(e, "time_travel")).toBe(0);
    expect(SCHEMA).not.toMatch(/enabled\s+BOOLEAN/);
  });
});

describe("a plan has to be in force, not merely chosen", () => {
  it("grants everything during a live trial", async () => {
    await setPlan("saas_pro", "trialing", new Date(Date.now() + 7 * 86_400_000).toISOString());
    const e = await get();
    expect(e.active).toBe(true);
    expect(ent.can(e, "rebilling")).toBe(true);
  });

  it("grants NOTHING once the trial has ended", async () => {
    /**
     * The one that leaks money. A trial that keeps working after it ends is not
     * a trial, it is a free tier nobody decided to offer — and it fails silently
     * in the direction where the customer is happy and no invoice appears.
     */
    await setPlan("saas_pro", "trialing", new Date(Date.now() - 60_000).toISOString());
    const e = await get();
    expect(e.active, "an expired trial still had access").toBe(false);
    expect(e.reason).toBe("trial_expired");
    expect(ent.can(e, "crm"), "even the base feature is gone").toBe(false);
  });

  it("keeps access while a payment is being retried", async () => {
    // Stripe retries a failed card for about two weeks. Locking somebody out
    // because a card expired on a Tuesday loses a customer over something they
    // would have fixed in a day — so access continues, flagged.
    await setPlan("unlimited", "past_due");
    const e = await get();
    expect(e.active).toBe(true);
    expect(e.inGrace).toBe(true);
    expect(ent.can(e, "api_access")).toBe(true);
  });

  it("grants nothing once cancelled", async () => {
    await setPlan("unlimited", "canceled");
    const e = await get();
    expect(e.active).toBe(false);
    expect(e.reason).toBe("canceled");
    expect(ent.can(e, "crm")).toBe(false);
  });

  it("grants nothing for an agency that does not exist", async () => {
    // Fails closed. An unknown agency resolving to a working plan would be a
    // way to get access by naming something that is not there.
    const e = await withSystem((q) => ent.entitlementsFor(q, "ag_does_not_exist"));
    expect(e.active).toBe(false);
    expect(e.reason).toBe("no_agency");
  });

  it("treats a trial with no end date as over", async () => {
    /**
     * This test asserted the opposite until 22 Aug 2026, on the reasoning that
     * "a missing date is not an expired one — cutting access because a field
     * was never set would punish an account for a bug in signup".
     *
     * Signup had exactly that bug. It inserted agencies with `plan_status =
     * 'trialing'` and no `trial_ends_at`, and this leniency turned that into a
     * free tier for every account ever created. Nothing errored, nobody
     * complained, and no invoice was ever due.
     *
     * The rule now runs the other way, in both places: signup sets the date,
     * and an unbounded trial counts as finished. Being wrong in this direction
     * produces a support message; being wrong in the other produced silence.
     */
    await setPlan("starter", "trialing", null);
    const e = await get();
    expect(e.active, "a trial with no end date granted access forever").toBe(false);
    expect(e.reason).toBe("trial_expired");
  });
});

describe("the active check is belt as well as braces", () => {
  it("refuses a granted feature when the plan is not in force", () => {
    /**
     * Today this is unreachable: an inactive plan returns an empty grant map,
     * so `grants.has()` is already false and removing the `active` check
     * changes nothing — a mutation proved exactly that.
     *
     * It stays, and is tested directly, because the two facts are independent.
     * The day something constructs entitlements from a cache, a webhook payload
     * or a future "paused" status, a populated grant map alongside an inactive
     * plan becomes reachable — and the failure would be a cancelled customer
     * with a working product.
     */
    const inactiveButGranted = {
      plan: "saas_pro",
      status: "canceled",
      active: false,
      inGrace: false,
      trialEndsAt: null,
      grants: new Map<string, number | null>([["rebilling", null]]),
    };

    expect(ent.can(inactiveButGranted, "rebilling"), "a cancelled plan granted a feature").toBe(false);
    expect(ent.limitOf(inactiveButGranted, "rebilling")).toBe(0);
    expect(ent.hasRoomFor(inactiveButGranted, "rebilling", 0)).toBe(false);
  });
});

describe("room for one more", () => {
  it("counts what exists rather than asking whether we are under the cap", async () => {
    /**
     * The off-by-one this signature exists to prevent: "am I under the limit"
     * and "may I add another" differ by exactly one, and getting it wrong ships
     * a plan that allows one more sub-account than it sells.
     */
    const e = await get(); // Starter: 3
    expect(ent.hasRoomFor(e, "sub_accounts", 0)).toBe(true);
    expect(ent.hasRoomFor(e, "sub_accounts", 2)).toBe(true);
    expect(ent.hasRoomFor(e, "sub_accounts", 3), "allowed a fourth on a cap of three").toBe(false);
    expect(ent.hasRoomFor(e, "sub_accounts", 99)).toBe(false);
  });

  it("always has room when the feature is uncapped", async () => {
    const e = await get();
    expect(ent.hasRoomFor(e, "contacts", 10_000)).toBe(true);
  });

  it("never has room for a feature that is not granted", async () => {
    const e = await get();
    expect(ent.hasRoomFor(e, "rebilling", 0)).toBe(false);
  });

  it("has no room at all once the trial lapses", async () => {
    await setPlan("starter", "trialing", new Date(Date.now() - 1000).toISOString());
    const e = await get();
    expect(ent.hasRoomFor(e, "sub_accounts", 0)).toBe(false);
  });
});

describe("refusals tell the person what to do next", () => {
  it("names the tier that includes the feature", async () => {
    const e = await get(); // Starter
    const r = ent.explain(e, "rebilling");
    expect(r.allowed).toBe(false);
    // "Not available on your plan" with no route forward is a dead end that
    // generates a support email.
    if (!r.allowed) expect(r.reason).toMatch(/SaaS Pro/);
  });

  it("says the trial ended rather than blaming the feature", async () => {
    await setPlan("saas_pro", "trialing", new Date(Date.now() - 1000).toISOString());
    const r = ent.explain(await get(), "crm");
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/trial has ended/i);
  });

  it("allows what is granted", async () => {
    expect(ent.explain(await get(), "crm").allowed).toBe(true);
  });

  it("names a tier for every feature no plan starts with", async () => {
    // Otherwise an upgrade prompt says "not included in your plan" and stops,
    // which is the dead end above wearing a different sentence.
    await setPlan("starter", "active");
    const starter = new Set((await get()).grants.keys());
    await setPlan("saas_pro", "active");
    const everything = [...(await get()).grants.keys()];

    for (const feature of everything) {
      if (starter.has(feature)) continue;
      expect(ent.FEATURE_TIER[feature], `no upgrade tier named for "${feature}"`).toBeTruthy();
    }
  });
});

describe("the sub-account limit is enforced where it matters", () => {
  let create: typeof import("../src/server/sub-accounts").createSubAccount;

  beforeAll(async () => {
    ({ createSubAccount: create } = await import("../src/server/sub-accounts"));
  });

  // The fixture already has two sub-accounts for this agency.
  const add = (name: string) => withSystem((q) => create(q, AGENCY, name));
  const countNow = () =>
    withSystem(async (q) => {
      const r = await q.one<{ n: string }>(
        `SELECT count(*)::text AS n FROM sub_accounts WHERE agency_id = $1 AND deleted_at IS NULL`,
        [AGENCY]
      );
      return Number(r?.n ?? 0);
    });

  beforeEach(async () => {
    await db.seed(`DELETE FROM sub_accounts WHERE name LIKE 'Cap test%'`);
    await setPlan("starter", "active");
  });

  it("allows a workspace while there is room", async () => {
    const before = await countNow();
    const r = await add("Cap test one");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await countNow()).toBe(before + 1);
  });

  it("refuses the one past the cap, and says how to fix it", async () => {
    // Starter sells three. Fill to the cap, then ask for one more.
    let guard = 0;
    while ((await countNow()) < 3 && guard++ < 10) {
      const r = await add(`Cap test fill ${guard}`);
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
    }
    expect(await countNow()).toBe(3);

    const r = await add("Cap test overflow");
    expect(r.ok, "a fourth workspace was created on a plan that sells three").toBe(false);
    if (!r.ok) {
      // A dead end generates a support email; naming the number and the way
      // out turns the same refusal into an upgrade prompt.
      expect(r.error).toMatch(/3 client workspaces/);
      expect(r.error).toMatch(/upgrade/i);
      expect(r.upgrade).toBe(true);
    }
    expect(await countNow(), "the refused workspace was written anyway").toBe(3);
  });

  it("allows the same request once the plan is upgraded", async () => {
    let guard = 0;
    while ((await countNow()) < 3 && guard++ < 10) await add(`Cap test fill ${guard}`);
    expect((await add("Cap test overflow")).ok).toBe(false);

    await setPlan("unlimited", "active");
    const r = await add("Cap test after upgrade");
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });

  it("refuses when the trial has lapsed, whatever the count", async () => {
    // Not a limit problem — the plan is not in force at all, and the message
    // should say that rather than blaming the number.
    await db.seed(`DELETE FROM sub_accounts WHERE name LIKE 'Cap test%'`);
    await setPlan("starter", "trialing", new Date(Date.now() - 1000).toISOString());
    const r = await add("Cap test lapsed");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/trial has ended/i);
  });

  it("counts under a lock, so two at once cannot both take the last slot", async () => {
    /**
     * Count, decide, write as three separate steps is how a Starter account
     * ends up with five workspaces: two requests both read three, both conclude
     * there is room, both write. The advisory lock names the invariant.
     *
     * Comments are stripped before matching. The first version of this check
     * passed against the doc comment that explains the lock, so deleting the
     * lock itself changed nothing — a guard reading prose instead of code.
     */
    const code = readFileSync(join(__dirname, "..", "src", "server", "sub-accounts.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    expect(code, "the count is not taken under a lock").toMatch(/pg_advisory_xact_lock/);
    // And the lock must be taken BEFORE the count is read, or it guards nothing.
    expect(code.indexOf("pg_advisory_xact_lock")).toBeLessThan(code.indexOf("SELECT count(*)"));
  });

  it("does not let a deleted workspace hold a slot", async () => {
    /**
     * Sub-accounts are soft-deleted, so a churned client leaves its row behind.
     * If the count ignores `deleted_at`, an agency that removes a client and
     * signs a new one is told to upgrade to get back to where they were — a
     * bill for capacity they already freed.
     */
    let guard = 0;
    while ((await countNow()) < 3 && guard++ < 10) await add(`Cap test fill ${guard}`);
    expect((await add("Cap test overflow")).ok, "the cap did not apply").toBe(false);

    await db.seed(`UPDATE sub_accounts SET deleted_at = now()
                   WHERE agency_id = '${AGENCY}' AND name = 'Cap test fill 1'`);

    const r = await add("Cap test after removal");
    expect(r.ok, r.ok ? "" : `a freed slot was still counted: ${r.error}`).toBe(true);
  });

  it("refuses a name that is only whitespace", async () => {
    const r = await add("   ");
    expect(r.ok).toBe(false);
  });
});

