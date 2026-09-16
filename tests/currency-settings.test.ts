import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/** Where a workspace's currency is kept, and what the database refuses. */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let settings: typeof import("../src/server/repos/settings");
let closePool: typeof import("../src/server/db").closePool;

const ctx = (sub: string): TenantContext => ({ agencyId: AGENCY, subAccountId: sub, userId: USER_A, role: "owner" });
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx(TENANT_A), fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  settings = await import("../src/server/repos/settings");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM settings;`));

describe("a workspace's currency", () => {
  it("IS DOLLARS UNTIL SOMEBODY CHOOSES — what every existing workspace has been showing", async () => {
    expect((await inA((q) => settings.getSettings(q))).currency).toBe("USD");
  });

  it("keeps the rand once chosen, and leaves the other settings alone", async () => {
    await inA((q) => settings.updateSettings(q, { monthlyTargetCents: 25_000_000, weeklyCapacity: 12 }));
    await inA((q) => settings.updateSettings(q, { currency: "ZAR" }));
    expect(await inA((q) => settings.getSettings(q))).toMatchObject({
      currency: "ZAR",
      monthlyTargetCents: 25_000_000,
      weeklyCapacity: 12,
    });
  });

  it("is each workspace's own", async () => {
    await inA((q) => settings.updateSettings(q, { currency: "ZAR" }));
    expect((await withTenant(ctx(TENANT_B), (q) => settings.getSettings(q))).currency).toBe("USD");
  });

  it("REFUSES A CURRENCY THIS PRODUCT CANNOT SHOW", async () => {
    await expect(
      inA((q) => settings.updateSettings(q, { currency: "XYZ" as never }))
    ).rejects.toThrow(/not a currency/);
  });

  it("the database refuses what is not a currency code at all", async () => {
    await expect(
      db.seed(`INSERT INTO settings (sub_account_id, currency) VALUES ('${TENANT_A}', 'rand')`)
    ).rejects.toThrow(/settings_currency_code/);
  });

  it("shows an unknown-but-valid code as dollars rather than breaking every page", async () => {
    /* A code a newer deployment added, read by an older one. */
    await db.seed(`INSERT INTO settings (sub_account_id, currency) VALUES ('${TENANT_A}', 'JPY')`);
    expect((await inA((q) => settings.getSettings(q))).currency).toBe("USD");
  });
});
