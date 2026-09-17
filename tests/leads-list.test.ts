import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * Which deal describes a person on the Leads screen.
 *
 * The page showed each contact by their EARLIEST deal, so a client who came
 * back vanished from it: the old won job made them "Closed Won" while the new
 * enquiry sat unlisted and uncounted. Found on 18 Sep 2026 against a fixture
 * where Home counted three open leads and this page showed two.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let leads: typeof import("../src/server/leads-view");
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);
const ago = (days: number) => `now() - interval '${days} days'`;

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  leads = await import("../src/server/leads-view");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES
      ('ct_returning', '${TENANT_A}', 'Amara', 'Dube'),
      ('ct_client',    '${TENANT_A}', 'Lindiwe', 'Khumalo'),
      ('ct_new',       '${TENANT_A}', 'Pieter', 'Venter'),
      ('ct_lost',      '${TENANT_A}', 'Thandi', 'Nkosi'),
      ('ct_theirs',    '${TENANT_B}', 'Bruno', 'Beta');
    INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage, source, won_at, created_at) VALUES
      ('d_old_won',  '${TENANT_A}', 'ct_returning', 'Roof',   1000, 'won',      'website',  ${ago(40)}, ${ago(60)}),
      ('d_new_open', '${TENANT_A}', 'ct_returning', 'Solar',  2000, 'demo',     'website',  NULL,       ${ago(2)}),
      ('d_client',   '${TENANT_A}', 'ct_client',    'Fence',  3000, 'won',      'referral', ${ago(30)}, ${ago(50)}),
      ('d_new',      '${TENANT_A}', 'ct_new',       'Deck',   4000, 'prospect', 'website',  NULL,       ${ago(8)}),
      ('d_lost',     '${TENANT_A}', 'ct_lost',      'Pool',   5000, 'lost',     'facebook', NULL,       ${ago(30)}),
      ('d_theirs',   '${TENANT_B}', 'ct_theirs',    'Theirs', 6000, 'demo',     'website',  NULL,       ${ago(1)});
  `)
);

describe("the leads list", () => {
  it("SHOWS A RETURNING CLIENT'S NEW ENQUIRY as open work, not as a closed sale", async () => {
    const list = await inA((q) => leads.listLeadsWithStatus(q));
    const amara = list.find((l) => l.id === "ct_returning");
    expect(amara?.status, "a client with a live enquiry was hidden behind their old win").toBe("Follow-up Required");
  });

  it("still calls somebody with nothing open a client, and never lists a lost-only contact", async () => {
    const list = await inA((q) => leads.listLeadsWithStatus(q));
    expect(list.find((l) => l.id === "ct_client")?.status).toBe("Closed Won");
    expect(list.find((l) => l.id === "ct_new")?.status).toBe("New Lead");
    expect(list.some((l) => l.id === "ct_lost"), "a contact whose only deal was lost is not a lead").toBe(false);
  });

  it("one row per person, and never another workspace's", async () => {
    const list = await inA((q) => leads.listLeadsWithStatus(q));
    expect(list.map((l) => l.id).sort()).toEqual(["ct_client", "ct_new", "ct_returning"]);
  });

  it("AGES A RETURNING CLIENT FROM THE NEW ENQUIRY, not the old job", async () => {
    /* Waiting "60 days" because of a job finished last year would send somebody
       to the top of the chase list for work that was already delivered. */
    const list = await inA((q) => leads.listLeadsWithStatus(q));
    const amara = list.find((l) => l.id === "ct_returning")!;
    const daysWaiting = Math.round((Date.now() - Date.parse(amara.createdAt ?? "")) / 86_400_000);
    expect(daysWaiting).toBe(2);
  });
});
