import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDb, TENANT_A, TENANT_B } from "./helpers/pg";

/**
 * Pain points — captured in Discovery, and what the Demo is built from.
 *
 * The mechanic at the centre of the process, and the thing a generic CRM does
 * not do. Discovery exists to find out what actually hurts; the Demo exists to
 * show those specific things stopping. Without it the demo is a feature tour,
 * which is the presentation everybody gives and nobody remembers.
 *
 * The data model and the server action existed for weeks with no way to reach
 * them: nothing in the interface captured a pain point or showed one. A feature
 * that only exists below the UI is a feature nobody has.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let deals: typeof import("../src/server/repos/deals");
let closePool: typeof import("../src/server/db").closePool;

const ctx = (subAccountId: string) => ({
  agencyId: "ag_test",
  subAccountId,
  userId: "u_test_a",
  role: "owner" as const,
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  deals = await import("../src/server/repos/deals");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM deals`));

const newDeal = (tenant = TENANT_A, stage: "discovery" | "demo" = "discovery") =>
  withTenant(ctx(tenant), (q) =>
    deals.createDeal(q, { title: "Acme", valueCents: 100000, stage })
  );

describe("capturing what hurts", () => {
  it("keeps the words in the order they were said", async () => {
    const deal = await newDeal();
    const updated = await withTenant(ctx(TENANT_A), (q) =>
      deals.addPainPoints(q, deal.id, ["Leads go cold", "No idea which ads pay"])
    );
    expect(updated?.painPoints).toEqual(["Leads go cold", "No idea which ads pay"]);
  });

  it("appends rather than replacing", async () => {
    /**
     * Appended in SQL, not read-modify-write. Two people finishing calls on the
     * same deal would each write back the array they read, and the second would
     * erase the first — a loss measured at 18 of 20 records on the old store.
     */
    const deal = await newDeal();
    await withTenant(ctx(TENANT_A), (q) => deals.addPainPoints(q, deal.id, ["First"]));
    const updated = await withTenant(ctx(TENANT_A), (q) =>
      deals.addPainPoints(q, deal.id, ["Second"])
    );
    expect(updated?.painPoints, "the earlier capture was overwritten").toEqual(["First", "Second"]);
  });

  it("survives two captures racing on the same deal", async () => {
    const deal = await newDeal();
    await Promise.all([
      withTenant(ctx(TENANT_A), (q) => deals.addPainPoints(q, deal.id, ["From Ana"])),
      withTenant(ctx(TENANT_A), (q) => deals.addPainPoints(q, deal.id, ["From Ben"])),
    ]);
    const after = await withTenant(ctx(TENANT_A), (q) => deals.getDeal(q, deal.id));
    expect(after?.painPoints.length, "one colleague's capture was lost").toBe(2);
    expect(after?.painPoints).toContain("From Ana");
    expect(after?.painPoints).toContain("From Ben");
  });

  it("ignores blank lines and whitespace", async () => {
    const deal = await newDeal();
    const updated = await withTenant(ctx(TENANT_A), (q) =>
      deals.addPainPoints(q, deal.id, ["  Leads go cold  ", "", "   "])
    );
    expect(updated?.painPoints).toEqual(["Leads go cold"]);
  });

  it("changes nothing when there is nothing to add", async () => {
    const deal = await newDeal();
    await withTenant(ctx(TENANT_A), (q) => deals.addPainPoints(q, deal.id, ["Real one"]));
    const updated = await withTenant(ctx(TENANT_A), (q) => deals.addPainPoints(q, deal.id, ["  "]));
    expect(updated?.painPoints).toEqual(["Real one"]);
  });
});

describe("removing one that was misheard", () => {
  it("removes by text, not by position", async () => {
    /**
     * Index-based removal looks simpler and is wrong: captures append, so a
     * colleague finishing a call between the render and the click shifts every
     * index down and the wrong point disappears.
     */
    const deal = await newDeal();
    await withTenant(ctx(TENANT_A), (q) =>
      deals.addPainPoints(q, deal.id, ["Keep this", "Remove this", "Keep this too"])
    );
    const updated = await withTenant(ctx(TENANT_A), (q) =>
      deals.removePainPoint(q, deal.id, "Remove this")
    );
    expect(updated?.painPoints).toEqual(["Keep this", "Keep this too"]);
  });

  it("removes only the first of a repeated phrase", async () => {
    // Two people hearing the same complaint is real. Deleting one must not
    // silently delete the other.
    const deal = await newDeal();
    await withTenant(ctx(TENANT_A), (q) =>
      deals.addPainPoints(q, deal.id, ["Same", "Other", "Same"])
    );
    const updated = await withTenant(ctx(TENANT_A), (q) =>
      deals.removePainPoint(q, deal.id, "Same")
    );
    expect(updated?.painPoints).toEqual(["Other", "Same"]);
  });

  it("does nothing when the text is not there", async () => {
    const deal = await newDeal();
    await withTenant(ctx(TENANT_A), (q) => deals.addPainPoints(q, deal.id, ["Only this"]));
    const updated = await withTenant(ctx(TENANT_A), (q) =>
      deals.removePainPoint(q, deal.id, "Never said")
    );
    expect(updated?.painPoints).toEqual(["Only this"]);
  });
});

describe("pain points belong to one workspace", () => {
  it("cannot be added to another tenant's deal", async () => {
    const deal = await newDeal(TENANT_A);
    const result = await withTenant(ctx(TENANT_B), (q) =>
      deals.addPainPoints(q, deal.id, ["Injected"])
    );
    expect(result, "another workspace reached this deal").toBeNull();

    const mine = await withTenant(ctx(TENANT_A), (q) => deals.getDeal(q, deal.id));
    expect(mine?.painPoints).toEqual([]);
  });

  it("cannot be removed from another tenant's deal", async () => {
    const deal = await newDeal(TENANT_A);
    await withTenant(ctx(TENANT_A), (q) => deals.addPainPoints(q, deal.id, ["Mine"]));

    await withTenant(ctx(TENANT_B), (q) => deals.removePainPoint(q, deal.id, "Mine"));

    const mine = await withTenant(ctx(TENANT_A), (q) => deals.getDeal(q, deal.id));
    expect(mine?.painPoints, "another workspace deleted this deal's notes").toEqual(["Mine"]);
  });
});

describe("they survive the deal being won", () => {
  it("carries onto the won record when a payment is taken", async () => {
    /**
     * Recording a payment creates a NEW deal row for the paid amount. Pain
     * points not copied across would vanish at the moment of the sale — the
     * record of why the customer bought, lost exactly when it becomes useful
     * for delivery and for the next pitch.
     */
    const deal = await newDeal(TENANT_A, "demo");
    await withTenant(ctx(TENANT_A), (q) =>
      deals.addPainPoints(q, deal.id, ["Leads go cold"])
    );
    await withTenant(ctx(TENANT_A), (q) => deals.recordPayment(q, deal.id, 100000));

    const all = await withTenant(ctx(TENANT_A), (q) => deals.listDeals(q));
    const won = all.find((d) => d.wonAt !== null);
    expect(won, "no won deal was created").toBeTruthy();
    expect(won?.painPoints, "the pain points were lost at the sale").toEqual(["Leads go cold"]);
  });
});

describe("the mechanic is reachable from the interface", () => {
  /**
   * The data model and the action existed for weeks with no way to reach them.
   * A feature that only exists below the UI is a feature nobody has, and
   * nothing in the suite noticed because every test called the repository
   * directly.
   */
  const BOARD = readFileSync(
    join(__dirname, "..", "src", "app", "(app)", "deals", "DealsBoard.tsx"),
    "utf8"
  );

  it("can capture a pain point", () => {
    expect(BOARD, "nothing in the board captures a pain point").toMatch(/addPainPointsAction\(/);
    expect(BOARD).toMatch(/name="painPoints"/);
  });

  it("can remove one", () => {
    expect(BOARD, "a mistyped pain point would be permanent").toMatch(/removePainPointAction\(/);
  });

  it("shows them, rather than only storing them", () => {
    const code = BOARD.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "pain points are stored but never rendered").toMatch(/deal\.painPoints/);
  });

  it("says so when a Demo has nothing to anchor to", () => {
    /**
     * The half that changes what somebody does. Counting captured points is
     * cheap; flagging their ABSENCE on a deal about to be demonstrated is the
     * part that stops the call being a feature tour.
     */
    const code = BOARD.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toMatch(/stage === "demo"/);
    expect(code, "a demo with no captured pain is not flagged").toMatch(/No pain captured/);
  });
});
