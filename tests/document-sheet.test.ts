import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * The printable document — the sheet a client actually files.
 *
 * Everywhere else in this product a figure is shown to somebody who can click
 * it and check. Here it is shown to somebody who cannot: it leaves as a PDF and
 * the next conversation about it happens six weeks later, with their copy on the
 * table. So these hold the two things that would make that conversation go
 * badly — a number that does not match what the workspace holds, and a claim on
 * the page that the workspace cannot back up.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const sheet = read("../src/app/(app)/documents/[id]/DocumentSheet.tsx");
/* The same file with its comments taken out. Some of what must not appear ON the
   page is discussed at length IN the file — the VAT reasoning most of all — and a
   search of the source would find the explanation and call it the defect. */
const sheetCode = sheet.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const page = read("../src/app/(app)/documents/[id]/page.tsx");
const view = read("../src/components/documents/DocumentLedgerView.tsx");

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let closePool: typeof import("../src/server/db").closePool;
let findDocument: typeof import("../src/server/repos/quotes").findDocument;
let documentLedger: typeof import("../src/server/document-ledger").documentLedger;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  ({ findDocument } = await import("../src/server/repos/quotes"));
  ({ documentLedger } = await import("../src/server/document-ledger"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM document_lines; DELETE FROM documents; DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('ct_ben', '${TENANT_A}', 'Ben', 'Cole', 'ben@cole.test');
    INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage) VALUES
      ('d_paving', '${TENANT_A}', 'ct_ben', 'Paving', 6000000, 'delivery');
    INSERT INTO documents (id, sub_account_id, deal_id, party_contact_id, kind, number, status, party, issued_on)
    VALUES ('q_1', '${TENANT_A}', 'd_paving', 'ct_ben', 'quote', 'Q-1', 'sent', 'Ben Cole', '2026-10-01');
    INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position) VALUES
      ('l1', '${TENANT_A}', 'q_1', 'Sand',   3.5, 120050, 0),
      ('l2', '${TENANT_A}', 'q_1', 'Labour', 1,   250000, 1);
  `)
);

describe("the figures on the sheet", () => {
  it("ARE THE SAME FIGURES THE LIST SHOWS — one read must not disagree with the other", async () => {
    /* The list and the sheet are two different queries over the same lines, and
       a client holding a printed R4,201.75 against a screen showing R4,202 is
       the one failure this feature cannot recover from. */
    const doc = await inA((q) => findDocument(q, "q_1"));
    const ledger = await inA((q) => documentLedger(q, "quote"));
    const row = ledger.rows.find((r) => r.id === "q_1");
    expect(doc?.totalCents).toBe(row?.totalCents);
  });

  it("keeps the half day: 3.5 at R1,200.50 is R4,201.75, and the total adds up", async () => {
    const doc = await inA((q) => findDocument(q, "q_1"));
    const sand = doc?.lines.find((l) => l.description === "Sand");
    expect(sand?.quantity).toBe(3.5);
    expect(sand?.totalCents).toBe(420175);
    /* 4,201.75 + 2,500.00 */
    expect(doc?.totalCents).toBe(670175);
  });

  it("reads the recipient's address the same way the send path does", async () => {
    /* The document has none of its own, so the contact's is what a client
       querying "you never sent it" would be shown. */
    const doc = await inA((q) => findDocument(q, "q_1"));
    expect(doc?.partyEmail).toBe("ben@cole.test");
  });

  it("carries the date on the face of it, not the day it was printed", async () => {
    const doc = await inA((q) => findDocument(q, "q_1"));
    expect(doc?.issuedOn).toBe("2026-10-01");
  });
});

describe("how the sheet prints them", () => {
  it("SHOWS TWO DECIMAL PLACES ON EVERY FIGURE, always", () => {
    /* `cents`, not `exact`: on a screen a trailing ".00" is noise, and on a
       document a column where some rows have cents and some do not is what makes
       a reader add it up by hand. */
    expect(sheet).toMatch(/formatMoney\(cents, currency, "cents"\)/);
  });

  it("never reaches for a rounding or shortening style", () => {
    for (const style of ["whole", "compact"]) {
      expect(sheetCode, `${style} must not reach a document`).not.toMatch(
        new RegExp(`formatMoney\\([^)]*"${style}"\\)`)
      );
    }
  });

  it("TOTALS NOTHING ITSELF — every figure comes from the database", () => {
    /* The lines and the total are both computed as ROUND(quantity * unit_cents)
       in SQL. A subtotal added up here would be a second opinion, in floating
       point, about the number on the page. */
    expect(sheetCode).not.toMatch(/quantity\s*\*\s*unit/i);
    expect(sheetCode).not.toMatch(/reduce\(/);
  });

  it("formats its date without Intl, so it cannot change as the page loads", () => {
    /* The same component renders on the server and again in the browser, and
       the two do not share locale data — money is hand-formatted for exactly
       this reason. */
    expect(sheetCode).not.toMatch(/Intl\./);
    expect(sheetCode).not.toMatch(/toLocaleDateString/);
  });
});

describe("on a phone", () => {
  it("FITS — the amount column and the total are not parked off the edge", () => {
    /* The first build floored the table at 420px and let it scroll inside its
       own box. On a 375px screen that hid the Amount column and the total —
       the two figures the page exists to show — behind a sideways gesture
       nothing on screen suggested. The type steps down instead. */
    expect(sheetCode).not.toMatch(/min-w-\[\d+px\]/);
    expect(sheetCode).not.toMatch(/overflow-x-auto/);
    expect(sheetCode).toMatch(/text-xs @min-\[520px\]:text-sm/);
  });

  it("keeps the print button a real touch target", () => {
    expect(sheetCode).toMatch(/min-h-\[44px\]/);
  });
});

describe("what the sheet does not claim", () => {
  it("MAKES NO VAT CLAIM — there is no VAT number or rate in this product", () => {
    /* A total that says "incl. VAT" on a document somebody hands to their
       accountant, with no registration number anywhere on it, is a tax claim
       made on nothing. When Settings holds those fields this can print them;
       until then it prints neither. */
    expect(sheetCode).not.toMatch(/VAT/i);
  });

  it("names WHO APPROVED IT from the document, never from whoever is reading", () => {
    /* The emailed copy names the person who said yes. A printed copy naming
       whoever opened the page would put two different names on one document. */
    expect(page).toMatch(/document\.approvedByUserId/);
    expect(sheet).toMatch(/approvedBy/);
    expect(sheetCode).not.toMatch(/preparedBy \?\?/);
  });

  it("shows payment details only on an invoice", () => {
    /* `invoicePayTo` is where to send money. On a quotation — which is a price,
       not a demand — it would be asking for payment for work not yet agreed. */
    expect(sheet).toMatch(/doc\.kind === "invoice" && payTo/);
  });
});

describe("what comes out of the printer", () => {
  const shell = read("../src/components/shell/AppShell.tsx");
  const sidebar = read("../src/components/shell/Sidebar.tsx");
  const topbar = read("../src/components/shell/Topbar.tsx");

  it("IS THE WHOLE DOCUMENT, not the first screenful", () => {
    /* The shell is `h-screen overflow-hidden` with its own scroller. Printed as
       it stands, page one comes out and the rest of a long quotation is silently
       missing — the worst way for this to fail, because it looks fine. */
    expect(shell).toMatch(/print:h-auto/);
    expect(shell).toMatch(/print:overflow-visible/);
    expect(shell).toMatch(/print:block/);
  });

  it("has no app furniture on it", () => {
    expect(sidebar).toMatch(/print:hidden/);
    expect(topbar).toMatch(/print:hidden/);
    /* Nor the controls that only make sense on screen. */
    expect(sheet).toMatch(/print:hidden/);
  });

  it("prints on white in both themes", () => {
    /* Not a theme token: a sheet that followed the night theme would come out
       as a page of solid ink, and the point of this screen is that it looks like
       what the client receives. */
    const css = read("../src/app/globals.css");
    expect(css).toMatch(/\.doc-sheet\s*\{[^}]*background:\s*#ffffff/i);
    expect(css).toMatch(/@media print/);
  });
});

describe("how it is reached", () => {
  it("is what the number in the list opens", () => {
    expect(view).toMatch(/href=\{`\/documents\/\$\{r\.id\}`\}/);
  });

  it("is never cached", () => {
    expect(page).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("READS THE WORKSPACE NAME WITH THE AGENCY FILTER, like every system read", () => {
    expect(page).toMatch(/FROM sub_accounts WHERE id = \$2 AND agency_id = \$1/);
  });

  it("does not open a system transaction inside the tenant one", () => {
    /* Two connections at once, and under a pool one deep that is a hang rather
       than an error — the trap the outbox handler documents. */
    const tenantBlock = page.slice(page.indexOf("withTenantPage("), page.indexOf("if (!data)"));
    expect(tenantBlock).not.toMatch(/withSystem\(/);
  });
});
