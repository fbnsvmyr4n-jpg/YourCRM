import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { groupByCompany, isLive } from "../src/server/projects-view";
import { STAGES } from "../src/server/repos/deals";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * Projects: the work, filed under the client it is for.
 *
 * A project is a deal seen a different way, which is the design and also the
 * thing that has to keep being true. Two halves are tested for two different
 * reasons:
 *
 *  - the GROUPING is pure arithmetic and ordering, checked against a fixture
 *    whose every answer was worked out by hand;
 *  - the LINK from a deal to a company is a database guarantee — derived on
 *    write, kept in step when the contact moves, and refused across a tenant
 *    boundary — so it is tested against a real Postgres rather than a mock.
 */

/* ---------- the grouping ---------- */

type Row = Parameters<typeof groupByCompany>[0][number];

function row(
  company: string,
  title: string,
  stage: Row["stage"],
  cents: number,
  activity: string
): Row {
  return {
    company_id: `co-${company}`,
    company_name: company,
    domain: null,
    id: `d-${title}`,
    title,
    stage,
    value_cents: String(cents),
    won_at: null,
    owner_name: "Sam Carter",
    contact_name: null,
    meetings: "0",
    last_activity_at: new Date(activity),
  };
}

/* Values chosen so no two totals coincide — a fixture where every figure is
   100 cannot tell a correct sum from a wrong one. Rows arrive newest first,
   which is what the SQL orders by. */
const rows: Row[] = [
  row("Heineken", "Rebuild warehouse", "delivery", 1_800_000_00, "2026-09-04"),
  row("Woolworths", "Distribution fitout", "won", 900_000_00, "2026-09-03"),
  row("Heineken", "Depot cold storage", "demo", 450_000_00, "2026-09-02"),
  row("Heineken", "Bottling survey", "referral", 120_000_00, "2026-08-01"),
  row("Old Mutual", "Head office refurb", "lost", 300_000_00, "2026-07-01"),
];

const named = (name: string) => groupByCompany(rows).find((c) => c.name === name)!;

describe("what counts as live work", () => {
  it("keeps a delivery job in the live list", () => {
    /*
       The case the whole split turns on. A delivered-but-unfinished job is the
       most live thing a client has — somebody is on site — and yet its deal is
       already won and its money already counted. Filing it under history
       because it closed would hide exactly the work this screen exists to show.
    */
    expect(isLive("delivery")).toBe(true);
    expect(named("Heineken").live.map((p) => p.title)).toContain("Rebuild warehouse");
  });

  it("treats won-but-not-started as still ahead of you", () => {
    expect(isLive("won")).toBe(true);
  });

  it("files referral and lost as history", () => {
    expect(isLive("referral")).toBe(false);
    expect(isLive("lost")).toBe(false);
    expect(named("Heineken").history.map((p) => p.title)).toEqual(["Bottling survey"]);
    expect(named("Old Mutual").history.map((p) => p.title)).toEqual(["Head office refurb"]);
  });

  it("has an answer for every stage the pipeline can be in", () => {
    // A stage added without a decision here would silently land in history.
    for (const stage of STAGES) {
      expect(typeof isLive(stage), `no verdict for "${stage}"`).toBe("boolean");
    }
  });
});

describe("what a client is worth", () => {
  it("counts delivery and referral money as won, not as pipeline", () => {
    // By hand: 1,800,000 delivery + 120,000 referral = 1,920,000 won.
    // Open is the demo alone: 450,000. The delivery job is live AND won, and
    // counting it as open would inflate the pipeline with work already paid for.
    const h = named("Heineken");
    expect(h.wonCents).toBe(1_920_000_00);
    expect(h.openCents).toBe(450_000_00);
  });

  it("counts a lost project as neither", () => {
    const om = named("Old Mutual");
    expect(om.wonCents).toBe(0);
    expect(om.openCents).toBe(0);
  });

  it("reads money out of the strings Postgres returns for BIGINT", () => {
    // Left as strings these would concatenate rather than add.
    expect(typeof named("Woolworths").wonCents).toBe("number");
    expect(named("Woolworths").wonCents).toBe(900_000_00);
  });
});

describe("the order clients appear in", () => {
  it("puts anyone with live work above anyone without", () => {
    const order = groupByCompany(rows).map((c) => c.name);
    expect(order).toEqual(["Heineken", "Woolworths", "Old Mutual"]);
  });

  it("orders the live ones by what was touched most recently", () => {
    // Heineken's newest is 4 Sept, Woolworths' is 3 Sept. A client you closed
    // millions with years ago should not outrank the warehouse being rebuilt
    // this week — that is the difference between this and a revenue report.
    const [first, second] = groupByCompany(rows);
    expect(first.name).toBe("Heineken");
    expect(second.name).toBe("Woolworths");
    expect(first.wonCents).toBeGreaterThan(second.wonCents);
  });

  it("does not rank by money", () => {
    // Old Mutual's lost job is worth more than nothing but it is dormant, and
    // a bigger dormant client must still sit below a smaller active one.
    const quiet = row("Quiet Co", "Ancient job", "referral", 5_000_000_00, "2020-01-01");
    const order = groupByCompany([...rows, quiet]).map((c) => c.name);
    expect(order[0]).toBe("Heineken");
    expect(order.at(-1)).toBe("Quiet Co");
  });

  it("keeps a client with only history rather than dropping them", () => {
    // Somebody you worked with once is a fact about who you have worked with.
    expect(groupByCompany(rows).map((c) => c.name)).toContain("Old Mutual");
  });

  it("returns nothing for nothing", () => {
    expect(groupByCompany([])).toEqual([]);
  });
});

/* ---------- the link to the company ---------- */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let deals: typeof import("../src/server/repos/deals");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);

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

beforeEach(() =>
  db.seed(`
    DELETE FROM deals; DELETE FROM contacts; DELETE FROM companies;
    INSERT INTO companies (id, sub_account_id, name) VALUES
      ('co_a', '${TENANT_A}', 'Heineken'),
      ('co_b', '${TENANT_B}', 'Another tenant''s client');
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, company_id) VALUES
      ('ct_a', '${TENANT_A}', 'Amara', 'Dube', 'co_a'),
      ('ct_none', '${TENANT_A}', 'Nobody', 'Attached', NULL);`)
);

const companyOf = (id: string) =>
  inA((q) =>
    q.one<{ company_id: string | null }>(`SELECT company_id FROM deals WHERE id = $1`, [id])
  );

describe("a deal knows which client it is for", () => {
  it("takes the company from the contact, without being asked", () => {
    // Nothing on the form says "company". Asking for it would be a field
    // somebody forgets, and an answer that can disagree with the contact.
    return inA(async (q) => {
      const d = await deals.createDeal(q, { title: "Rebuild warehouse", contactId: "ct_a" });
      expect(d.companyId).toBe("co_a");
    });
  });

  it("leaves it unset when the contact has no company", async () => {
    const d = await inA((q) => deals.createDeal(q, { title: "Unfiled", contactId: "ct_none" }));
    expect(d.companyId).toBeNull();
  });

  it("leaves it unset when there is no contact at all", async () => {
    const d = await inA((q) => deals.createDeal(q, { title: "No contact yet" }));
    expect(d.companyId).toBeNull();
  });

  it("follows the contact when the deal is reassigned", async () => {
    const d = await inA((q) => deals.createDeal(q, { title: "Moves", contactId: "ct_a" }));
    await inA((q) => deals.updateDeal(q, d.id, { contactId: "ct_none" }));
    // Left alone this would keep filing under Heineken for a contact who has
    // nothing to do with them — the silent detachment in the other direction.
    expect((await companyOf(d.id))?.company_id).toBeNull();
  });

  it("does not clear the company when something else is edited", async () => {
    const d = await inA((q) => deals.createDeal(q, { title: "Rename me", contactId: "ct_a" }));
    await inA((q) => deals.updateDeal(q, d.id, { title: "Renamed" }));
    expect((await companyOf(d.id))?.company_id).toBe("co_a");
  });

  it("refuses a company belonging to another tenant", async () => {
    // A foreign key says the company is a real row and says nothing about
    // whose it is, and row level security does not catch this: the write
    // targets a row in THIS tenant and is legitimately allowed. Only the value
    // is wrong — and the projects page joins companies to show the name, so it
    // would render one customer's client on another customer's screen.
    const d = await inA((q) => deals.createDeal(q, { title: "Cross tenant" }));
    await expect(
      db.seed(`UPDATE deals SET company_id = 'co_b' WHERE id = '${d.id}'`)
    ).rejects.toThrow(/does not belong to sub-account/);
    expect((await companyOf(d.id))?.company_id).toBeNull();
  });

  it("refuses a cross-tenant company on a contact too", async () => {
    // The same hole existed on contacts and had never been closed. Adding a
    // second way to reach it was the reason to fix both.
    await expect(
      db.seed(`UPDATE contacts SET company_id = 'co_b' WHERE id = 'ct_a'`)
    ).rejects.toThrow(/does not belong to sub-account/);
  });
});
