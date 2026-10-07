/*
   A lead's company, and the menu that could not be used.

   Found by signing in as `member` — the salesperson, the role this product is
   actually for — and working the Leads page the way one would.

   Two defects, both of the same family as the finance and IT passes: the
   product holds the answer and the screen will not give it to you.

     1. Every card read a free-text column that has been empty since companies
        became records of their own, under the label "Project Info". So a lead
        working for a firm this CRM knows by name showed a dash, with the answer
        two tables away.

     2. EDIT AND DELETE BOTH DID NOTHING. The menu opened; the click that should
        have reached either one closed the menu instead. Nothing looked broken —
        a menu closing is what a click outside it does — so the only way to find
        this was to press it.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { startTestDb, type TestDb, TENANT_A, AGENCY, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let leads: typeof import("../src/server/leads-view");
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = {
  agencyId: AGENCY,
  subAccountId: TENANT_A,
  userId: USER_A,
  role: "owner",
};

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  leads = await import("../src/server/leads-view");

  await db.seed(`
    INSERT INTO companies (id, sub_account_id, name) VALUES
      ('co_filed', '${TENANT_A}', 'Dube Landscaping');

    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, company_id, info) VALUES
      -- Filed under a company RECORD, and the free text left behind from before.
      ('ct_filed',   '${TENANT_A}', 'Amara',  'Dube',  'a@d.test', 'co_filed', 'typed years ago'),
      -- No record, only the free text somebody typed into the lead form.
      ('ct_typed',   '${TENANT_A}', 'Sarah',  'Adams', 's@a.test', NULL,       'Adams Roofing'),
      -- Neither.
      ('ct_neither', '${TENANT_A}', 'Pieter', 'Venter','p@v.test', NULL,       '');

    INSERT INTO deals (id, sub_account_id, contact_id, title, stage, source) VALUES
      ('d_filed',   '${TENANT_A}', 'ct_filed',   'A', 'prospect', 'referral'),
      ('d_typed',   '${TENANT_A}', 'ct_typed',   'B', 'prospect', 'referral'),
      ('d_neither', '${TENANT_A}', 'ct_neither', 'C', 'prospect', 'referral');
  `);
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const cards = async () => withTenant(ctx, (q) => leads.listLeadsWithStatus(q));
const byName = async (name: string) => (await cards()).find((c) => c.name.startsWith(name));

describe("the company on a lead card", () => {
  it("IS THE COMPANY RECORD, not the free text left beside it", async () => {
    /*
       The defect. `Amara Dube` works for a company this workspace holds by
       name, and the card showed whatever happened to be in `info` — which the
       backfill emptied, so in practice a dash. The free text here says
       something else entirely, so a card reading it is unmistakable.
    */
    const lead = await byName("Amara");
    expect(lead?.company).toBe("Dube Landscaping");
    expect(lead?.companyFromRecord).toBe(true);
  });

  it("falls back to the free text when there is no company on file", async () => {
    /* Not everyone is filed under a company, and the lead form can still take
       a name. Losing that would trade one empty field for another. */
    const lead = await byName("Sarah");
    expect(lead?.company).toBe("Adams Roofing");
    expect(lead?.companyFromRecord).toBe(false);
  });

  it("says nothing rather than guessing when there is neither", async () => {
    const lead = await byName("Pieter");
    expect(lead?.company).toBe("");
    expect(lead?.companyFromRecord).toBe(false);
  });

  it("carries the RAW text separately, so the form cannot copy a record's name", async () => {
    /*
       The trap this closes, which the first fix would otherwise have opened.
       The edit form writes the free-text column and is pre-filled from the
       lead. Pre-filled from the RESOLVED name, saving a filed lead would write
       "Dube Landscaping" into a second place, where it goes stale the moment
       the company is renamed — a worse bug than the dash.
    */
    const lead = await byName("Amara");
    expect(lead?.companyNote).toBe("typed years ago");
    expect(lead?.companyNote).not.toBe(lead?.company);
  });
});

describe("the form that edits it", () => {
  const view = read("src/app/(app)/leads/LeadCardsSection.tsx");

  it("OFFERS NO BOX WHOSE VALUE WOULD BE IGNORED", () => {
    /* For a lead filed under a company, an editable box would accept a name,
       save it, and change nothing visible — the record still wins on the card.
       A control that silently does nothing is the fault this whole field was
       being fixed for, so the form states where the name lives instead. */
    expect(view).toMatch(/\{lead\?\.companyFromRecord \? \(/);
    expect(view).toMatch(/filed under this company\. Change it on their\s*\n?\s*contact\./);
  });

  it("defaults the box from the raw text, never from the resolved name", () => {
    expect(view).toMatch(/name="company"[\s\S]{0,200}defaultValue=\{value\("company", lead\?\.companyNote\)\}/);
  });

  it("calls it Company, because that is what it holds", () => {
    expect(view, "the card still says Project Info").not.toMatch(/label="Project Info"/);
  });
});

describe("the menu on a lead card", () => {
  const view = read("src/app/(app)/leads/LeadCardsSection.tsx");

  it("IS PORTALLED, so its own click-away is the one above it", () => {
    /*
       THE BUG, and it is a stacking-context bug rather than a logic one.

       The panel was `absolute … z-30` inside the card. The click-away catcher
       was `fixed inset-0 z-20` and PORTALLED to the document root. A z-index is
       only comparable within one stacking context, so the card's 30 was never
       measured against the root's 20: the portalled layer, painted later at the
       top level, sat over the menu. Clicking Edit hit the catcher, which closed
       the menu — and a menu closing on a click is exactly what nothing being
       wrong looks like.

       `AnchoredMenu` renders the panel and its click-away into ONE portal, so
       the two are ordered against each other. It is also what stops the card's
       `overflow` clipping the panel, which is what it was written for.
    */
    expect(view).toMatch(/<AnchoredMenu\s+anchor=\{menuButton\}/);
    expect(
      view,
      "a second, un-portalled click-away is back over the menu"
    ).not.toMatch(/fixed inset-0 z-20/);
  });

  it("anchors on STATE, not a ref read during render", () => {
    /* A ref is null on the render that first opens the menu, so the panel would
       have nothing to hang from and would not position. */
    expect(view).toMatch(/const \[menuButton, setMenuButton\] = useState<HTMLButtonElement \| null>\(null\)/);
    expect(view).toMatch(/ref=\{setMenuButton\}/);
  });
});
