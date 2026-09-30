import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * What the bell counts, against what every other screen counts.
 *
 * A notification is a claim about the workspace, made on every page at once,
 * and the only thing worse than a missing one is one that disagrees with the
 * screen it links to.
 *
 * Found on 2026-09-30: the bell filtered leads to `hasOpenDeal && !isClient`,
 * so a customer who had bought before and had a live enquiry was the one
 * person it would not remind anybody about — the likeliest sale on the board.
 * It said "2 leads" while Home, Reports, the Leads page and the assistant all
 * said 3. The comment directly above the filter already said a lead is a
 * contact with a deal in play; the code disagreed with its own sentence.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let listNotifications: typeof import("../src/server/notifications").listNotifications;
let reportData: typeof import("../src/server/analytics").reportData;
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);
const bell = () => inA((q) => listNotifications(q));
const leadItem = async () => (await bell()).find((n) => n.id === "leads-open");

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  ({ listNotifications } = await import("../src/server/notifications"));
  ({ reportData } = await import("../src/server/analytics"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM meetings; DELETE FROM calls; DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES
      ('ct_returning', '${TENANT_A}', 'Amara', 'Dube'),
      ('ct_new',       '${TENANT_A}', 'Pieter', 'Venter'),
      ('ct_done',      '${TENANT_A}', 'Ben', 'Cole'),
      ('ct_theirs',    '${TENANT_B}', 'Bruno', 'Beta');
    INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage, won_at) VALUES
      -- Bought before AND asking about more work: a client and a lead at once.
      ('d_old',    '${TENANT_A}', 'ct_returning', 'Roof',  12000000, 'won',      now()),
      ('d_live',   '${TENANT_A}', 'ct_returning', 'Solar',  2500000, 'demo',     NULL),
      ('d_new',    '${TENANT_A}', 'ct_new',       'Deck',   3000000, 'prospect', NULL),
      ('d_closed', '${TENANT_A}', 'ct_done',      'Paving', 6000000, 'won',      now()),
      ('d_theirs', '${TENANT_B}', 'ct_theirs',    'Theirs', 9000000, 'demo',     NULL);
  `)
);

describe("the leads the bell counts", () => {
  it("INCLUDES A RETURNING CLIENT WITH A LIVE ENQUIRY — the likeliest sale there is", async () => {
    const item = await leadItem();
    expect(item?.title, "a client with an open deal was left out").toMatch(/^2 leads/);
    expect(item?.detail).toMatch(/Amara Dube/);
  });

  it("AGREES WITH THE FIGURE REPORTS AND HOME SHOW", async () => {
    /* The point of the test. Two screens disagreeing about the same workspace
       at the same moment is how somebody stops believing either. */
    const report = await inA((q) => reportData(q));
    const item = await leadItem();
    expect(item?.title).toMatch(new RegExp(`^${report.contacts.leads} lead`));
  });

  it("leaves out somebody whose only deal is finished", async () => {
    expect((await leadItem())?.detail).not.toMatch(/Ben Cole/);
  });

  it("never counts another workspace's people", async () => {
    expect((await leadItem())?.detail).not.toMatch(/Bruno/);
  });

  it("says how many it did not name, rather than listing three under a count of nine", async () => {
    await db.seed(`
      INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES
        ('ct_a', '${TENANT_A}', 'Ana', 'One'),
        ('ct_b', '${TENANT_A}', 'Bea', 'Two'),
        ('ct_c', '${TENANT_A}', 'Cal', 'Three');
      INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage) VALUES
        ('d_a', '${TENANT_A}', 'ct_a', 'A', 100, 'demo'),
        ('d_b', '${TENANT_A}', 'ct_b', 'B', 100, 'demo'),
        ('d_c', '${TENANT_A}', 'ct_c', 'C', 100, 'demo');
    `);
    const item = await leadItem();
    expect(item?.title).toMatch(/^5 leads/);
    expect(item?.detail).toMatch(/and 2 more/);
  });

  it("says nothing at all when nobody has a deal in play", async () => {
    await db.seed(`DELETE FROM deals WHERE stage NOT IN ('won');`);
    expect(await leadItem()).toBeUndefined();
  });
});
