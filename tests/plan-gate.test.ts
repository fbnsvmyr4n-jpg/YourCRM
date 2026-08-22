import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDb, AGENCY, TENANT_A } from "./helpers/pg";

/**
 * Whether a lapsed account can still use the product.
 *
 * Entitlements were consulted in exactly one place — creating a sub-account —
 * and displayed in one more. Everything else ignored them, so a cancelled
 * subscription and an expired trial both kept the whole CRM. Phase 5's plans,
 * trials and Stripe wiring were all working while that was true, which is the
 * point: billing that computes the right answer and then does nothing with it
 * is not billing.
 */

const SCHEMA = readFileSync(join(__dirname, "..", "src", "server", "schema.sql"), "utf8");

let db: TestDb;
let planState: typeof import("../src/server/plan-gate").planState;
let requireActivePlan: typeof import("../src/server/plan-gate").requireActivePlan;
let closePool: typeof import("../src/server/db").closePool;

beforeAll(async () => {
  db = await startTestDb();
  ({ planState, requireActivePlan } = await import("../src/server/plan-gate"));
  ({ closePool } = await import("../src/server/db"));
});

afterAll(async () => {
  await closePool();
  await db.stop();
});

const setPlan = (status: string, trialEndsAt: string | null = null) =>
  db.seed(
    `UPDATE agencies SET plan = 'starter', plan_status = '${status}',
       trial_ends_at = ${trialEndsAt ? `'${trialEndsAt}'::timestamptz` : "NULL"}
     WHERE id = '${AGENCY}'`
  );

beforeEach(() => setPlan("active"));

describe("the gate lets a paying customer through", () => {
  it("allows an active plan", async () => {
    expect((await planState(AGENCY)).active).toBe(true);
  });

  it("allows a trial that is still running", async () => {
    await setPlan("trialing", new Date(Date.now() + 86_400_000).toISOString());
    expect((await planState(AGENCY)).active).toBe(true);
  });

  it("allows a failed payment while Stripe is still retrying", async () => {
    /**
     * The one that matters most for keeping customers. Stripe retries a card
     * for about two weeks; locking somebody out on day one of that loses them
     * over a problem they would have fixed the same afternoon.
     */
    await setPlan("past_due");
    expect((await planState(AGENCY)).active, "a recoverable payment locked the account").toBe(true);
  });
});

describe("the gate stops an account that is not paying", () => {
  it("stops a cancelled subscription", async () => {
    await setPlan("canceled");
    const state = await planState(AGENCY);
    expect(state.active, "a cancelled account kept the product").toBe(false);
    expect(state.reason).toMatch(/cancelled/i);
  });

  it("stops a trial that has ended", async () => {
    await setPlan("trialing", new Date(Date.now() - 1000).toISOString());
    const state = await planState(AGENCY);
    expect(state.active, "an expired trial kept the product").toBe(false);
    expect(state.reason).toMatch(/trial/i);
  });

  it("stops a trial that never had an end date", async () => {
    await setPlan("trialing", null);
    expect((await planState(AGENCY)).active).toBe(false);
  });

  it("says what to do, not merely that access is denied", async () => {
    // A dead end generates a support email. Every refusal names the way out.
    await setPlan("canceled");
    const { reason } = await planState(AGENCY);
    expect(reason.length).toBeGreaterThan(20);
    expect(reason).toMatch(/plan|reactivate/i);
  });

  it("throws for a server action, carrying the same message", async () => {
    await setPlan("canceled");
    await expect(requireActivePlan(AGENCY, "test")).rejects.toThrow(/cancelled/i);
  });

  it("does not throw for an active plan", async () => {
    await expect(requireActivePlan(AGENCY, "test")).resolves.toBeUndefined();
  });

  it("stops an agency that does not exist", async () => {
    // Fails closed. An unknown agency resolving to a working plan would be a
    // way to get the product by naming something that is not there.
    expect((await planState("ag_nope")).active).toBe(false);
  });
});

describe("a lapsed account keeps its data", () => {
  it("deletes and hides nothing", async () => {
    /**
     * The records come straight back on payment. A lapse is a customer with a
     * problem, not a former customer — and a product that empties their CRM
     * while they sort out a card is one they will not come back to.
     */
    await db.seed(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name, email)
       VALUES ('c_lapse', '${TENANT_A}', 'Still', 'Here', 'a@b.c')
       ON CONFLICT (id) DO NOTHING`
    );
    await setPlan("canceled");

    const { withSystem } = await import("../src/server/tenant");
    const row = await withSystem((q) =>
      q.one<{ first_name: string }>(`SELECT first_name FROM contacts WHERE id = 'c_lapse'`)
    );
    expect(row?.first_name, "a lapsed account's records were removed").toBe("Still");
  });
});

describe("no server action escapes the gate by accident", () => {
  const APP = join(__dirname, "..", "src", "app");

  const walk = (dir: string): string[] =>
    !existsSync(dir)
      ? []
      : readdirSync(dir).flatMap((f) => {
          const full = join(dir, f);
          if (statSync(full).isDirectory()) return walk(full);
          return f.endsWith(".ts") ? [full] : [];
        });

  const actionFiles = walk(APP).filter((f) => /^\s*["']use server["']/.test(readFileSync(f, "utf8")));

  /**
   * Actions that resolve the tenant themselves rather than through
   * `withCurrentTenant`, and so are not gated by it. Each needs a reason.
   *
   * The list is the point. `withCurrentTenant` gates 49 call sites at once;
   * these seven sidestep it, and without this test the eighth would arrive
   * unnoticed — which is exactly how 31 actions once shipped without an
   * authorisation check.
   */
  /**
   * Actions that must KEEP WORKING while the plan has lapsed, each with a
   * reason. These are genuinely ungated, and that is the intent.
   */
  const WORKS_WHILE_LAPSED: Record<string, string> = {
    startCheckoutAction:
      "takes payment. Gating the one action that fixes a lapse would trap the " +
      "customer on a screen asking them to do the thing they cannot do.",
    billingPortalAction:
      "same: cards, invoices and reactivation all live in Stripe's portal.",
    updateProfileAction:
      "account management, not product use. Somebody must be able to correct " +
      "their own name or email while sorting out a payment.",
    changePasswordAction:
      "account management, and a security control besides — never gate the " +
      "ability to change a password.",
    switchWorkspaceAction:
      "sets a cookie naming which workspace to read. Harmless while lapsed: " +
      "every page renders the billing screen regardless of which one is chosen.",
  };

  /**
   * Actions gated by something other than `withCurrentTenant`, named.
   *
   * The claim is checked below rather than believed. An excuse that says "this
   * is gated another way" and is not is worse than no excuse: it reads as a
   * decision somebody made, and it silences the check that would have caught
   * it. Removing the gate from `sendChatAction` passed this suite until the
   * mechanism itself was asserted.
   */
  const GATED_ELSEWHERE: Record<string, { by: RegExp; why: string }> = {
    createWorkspaceAction: {
      by: /createSubAccount\(/,
      why: "its entitlement check lives inside createSubAccount, which refuses outright when the plan is not in force",
    },
    sendChatAction: {
      by: /requireActivePlan\(/,
      why: "gated explicitly — it is the bypass that costs money per use, since every message is a billed call to Anthropic's API",
    },
  };

  const UNGATED = { ...WORKS_WHILE_LAPSED, ...GATED_ELSEWHERE };

  it("finds the action modules (a suite matching nothing proves nothing)", () => {
    expect(actionFiles.length).toBeGreaterThanOrEqual(9);
  });

  it("every action is gated, or is listed with a reason", () => {
    for (const file of actionFiles) {
      const src = readFileSync(file, "utf8");
      const names = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);

      for (const name of names) {
        const start = src.indexOf(`export async function ${name}`);
        const next = names
          .map((n) => src.indexOf(`export async function ${n}`))
          .filter((i) => i > start)
          .sort((a, b) => a - b)[0];
        const body = src.slice(start, next === undefined ? src.length : next);

        // Only actions that resolve a tenant are in scope. Sign-in, sign-up
        // and password reset run for somebody who has no account yet, let
        // alone a plan — gating those would lock a customer out of the login
        // page the moment their subscription lapsed.
        const resolvesTenant =
          /requireTenant\(\)/.test(body) || /withCurrentTenant\(/.test(body);
        if (!resolvesTenant) continue;

        const gated =
          /withCurrentTenant\(/.test(body) || /requireActivePlan\(/.test(body);
        const excused = name in UNGATED;

        expect(
          gated || excused,
          `${name}() resolves the tenant without passing the plan gate — ` +
            `a cancelled account could still use it. Route it through ` +
            `withCurrentTenant, call requireActivePlan, or add it to UNGATED with a reason.`
        ).toBe(true);
      }
    }
  });

  const bodyOf = (name: string): string | null => {
    for (const file of actionFiles) {
      const src = readFileSync(file, "utf8");
      const start = src.indexOf(`export async function ${name}`);
      if (start < 0) continue;
      const rest = src.slice(start + 1);
      const next = rest.indexOf("\nexport async function ");
      return next < 0 ? rest : rest.slice(0, next);
    }
    return null;
  };

  it("every excused action still exists, with a reason worth reading", () => {
    // A stale entry is a gate somebody thinks is deliberate and is not.
    for (const name of Object.keys(UNGATED)) {
      expect(bodyOf(name), `${name} is excused from the plan gate but no longer exists`).not.toBeNull();
    }
    for (const [name, reason] of Object.entries(WORKS_WHILE_LAPSED)) {
      expect(reason.length, `${name} has no reason recorded`).toBeGreaterThan(30);
    }
  });

  it("an action excused as 'gated elsewhere' really is", () => {
    for (const [name, { by, why }] of Object.entries(GATED_ELSEWHERE)) {
      const body = bodyOf(name);
      expect(body, `${name} no longer exists`).not.toBeNull();
      expect(
        by.test(body!),
        `${name} is excused because ${why}, but ${by} is not in it — ` +
          `the excuse is now the only thing standing between a cancelled account and this action`
      ).toBe(true);
    }
  });

  it("the shared entry point actually applies the gate", () => {
    /**
     * Everything above rests on `withCurrentTenant` calling it. If that call
     * goes, all 49 gated actions silently become ungated and every assertion
     * here still passes — the check would be measuring the wrong thing.
     */
    const src = readFileSync(
      join(__dirname, "..", "src", "server", "tenant-session.ts"),
      "utf8"
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "withCurrentTenant no longer checks the plan").toMatch(/requireActivePlan\(/);
    // And the escape hatch must stay opt-in: a default of `allowInactive: true`
    // would disable the gate everywhere while looking like it was still there.
    expect(code).not.toMatch(/allowInactive\s*[:=]\s*true\s*\}?\s*=\s*\{?\s*\}/);
    expect(code).toMatch(/if\s*\(!options\.allowInactive\)/);
  });

  it("the layout gates every page in the group", () => {
    // Pages are not gated by `withTenantPage` — it passes `allowInactive` so a
    // lapse renders the billing screen rather than an error boundary. That only
    // holds while the layout does the gating.
    const layout = readFileSync(join(APP, "(app)", "layout.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(layout, "the app layout no longer checks the plan").toMatch(/planState\(/);
    expect(layout, "a lapsed account is not shown the billing screen").toMatch(/PlanLapsed/);
    // The branch itself, not merely the names. `if (false)` left both mentions
    // in place while every page rendered normally on a cancelled plan.
    expect(
      layout,
      "the layout mentions the plan but no longer branches on it"
    ).toMatch(/if\s*\(\s*!\s*plan\.active\s*\)/);
  });

  it("reaches the billing card without a plan, so the customer can pay", () => {
    // The screen a lapsed customer sees has to contain the way out of the
    // lapse. Rendering a dead end would be worse than showing nothing.
    const lapsed = readFileSync(
      join(__dirname, "..", "src", "components", "billing", "PlanLapsed.tsx"),
      "utf8"
    );
    expect(lapsed).toMatch(/BillingCard/);
    expect(lapsed).toMatch(/signOutAction/);
  });
});

/** Keeps the schema import honest — it is read to build the fixture database. */
it("uses the real schema", () => {
  expect(SCHEMA).toContain("CREATE TABLE IF NOT EXISTS agencies");
});
