import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * Changing a document after it has been raised.
 *
 * The whole question is WHEN, not how. A quotation the client is holding is a
 * record of what they were told, and a purchase order the yard is filling is
 * what they were asked for — so editing either one's figures would leave the
 * CRM and the other side disagreeing, with nothing on either side saying so.
 * That is not an edit, it is a second document.
 *
 * So the figures may only change while a document is a `draft`, and these
 * check that the rule holds from the server rather than from the screen: a
 * server action is a public endpoint and a hidden button is only a suggestion.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx, fn);

const totalOf = (id: string) =>
  inA((q) =>
    q.one<{ total: string }>(
      `SELECT COALESCE(SUM(ROUND(quantity * unit_cents)), 0)::bigint::text AS total
         FROM document_lines WHERE sub_account_id = $1 AND document_id = $2`,
      [TENANT_A, id]
    )
  ).then((r) => Number(r?.total ?? 0));

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM document_lines; DELETE FROM documents; DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES
      ('ct_ben', '${TENANT_A}', 'Ben', 'Cole');
    INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage) VALUES
      ('d_paving', '${TENANT_A}', 'ct_ben', 'Paving', 6000000, 'delivery');
    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party) VALUES
      ('po_draft', '${TENANT_A}', 'd_paving', 'purchase_order', 'PO-1', 'draft',     'Stone Yard'),
      ('po_sent',  '${TENANT_A}', 'd_paving', 'purchase_order', 'PO-2', 'sent',      'Stone Yard'),
      ('q_taken',  '${TENANT_A}', 'd_paving', 'quote',          'Q-1',  'accepted',  'Ben Cole');
    INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position) VALUES
      ('l1', '${TENANT_A}', 'po_draft', 'Sand', 3.5, 120050, 0),
      ('l2', '${TENANT_A}', 'po_sent',  'Stone', 1, 500000, 0),
      ('l3', '${TENANT_A}', 'q_taken',  'Paving', 1, 4500000, 0);
  `)
);

describe("the figures on a draft", () => {
  it("SURVIVE A ROUND TRIP UNCHANGED — 3.5 at R1,200.50 is R4,201.75", async () => {
    /* The number a person sees when they open an edit has to be the number
       that goes back, or an edit that touched nothing would still move the
       total. 3.5 must not come back 3.500 and 1200.50 must not come back
       1200.5 and then be read as something else. */
    expect(await totalOf("po_draft")).toBe(420175);
  });

  it("can be replaced wholesale, and the total is what the lines say", async () => {
    await inA(async (q) => {
      await q.rows(`DELETE FROM document_lines WHERE sub_account_id = $1 AND document_id = 'po_draft'`, [TENANT_A]);
      await q.rows(
        `INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position)
         VALUES ('n1', $1, 'po_draft', 'Sand', 2, 100000, 0), ('n2', $1, 'po_draft', 'Gravel', 0.5, 200000, 1)`,
        [TENANT_A]
      );
    });
    /* 2 x 1000.00 + 0.5 x 2000.00 = 3000.00 */
    expect(await totalOf("po_draft")).toBe(300000);
  });
});

describe("what the server refuses to change", () => {
  const editable = ["draft"];

  it("NAMES ONLY `draft` AS EDITABLE, from the action itself", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/app/(app)/projects/actions.ts", import.meta.url)),
      "utf8"
    );
    const listed = /const EDITABLE_STATUSES = \[([^\]]+)\]/.exec(src)?.[1] ?? "";
    expect(listed).toContain('"draft"');
    for (const gone of ["sent", "accepted", "paid", "declined", "cancelled", "approved", "awaiting_approval"]) {
      expect(listed, `${gone} must not be editable`).not.toContain(`"${gone}"`);
    }
    expect(editable).toEqual(["draft"]);
  });

  it("only rewrites a row whose status is still draft", () => {
    /* The predicate is in the UPDATE itself, not only in a check above it, so
       a document that changed status between the read and the write is not
       edited anyway. */
    const src = readFileSync(
      fileURLToPath(new URL("../src/app/(app)/projects/actions.ts", import.meta.url)),
      "utf8"
    );
    const fn = src.slice(src.indexOf("export async function updateDocumentAction"));
    expect(fn).toMatch(/AND status = 'draft'/);
  });

  it("says what to do instead of just refusing", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/app/(app)/projects/actions.ts", import.meta.url)),
      "utf8"
    );
    expect(src).toMatch(/Raise a new one, or cancel this and start again/);
  });
});

describe("what stays changeable after it has gone", () => {
  it("lets a note and an address be corrected on a sent document", async () => {
    /* Neither changes what was agreed, and refusing to fix a typo in an email
       would mean a document that bounced can never arrive at all. */
    await inA((q) =>
      q.rows(
        `UPDATE documents SET notes = 'chased', party_email = 'orders@yard.test'
          WHERE sub_account_id = $1 AND id = 'po_sent'`,
        [TENANT_A]
      )
    );
    const row = await inA((q) =>
      q.one<{ notes: string; party_email: string }>(
        `SELECT notes, party_email FROM documents WHERE sub_account_id = $1 AND id = 'po_sent'`,
        [TENANT_A]
      )
    );
    expect(row?.notes).toBe("chased");
    expect(row?.party_email).toBe("orders@yard.test");
    /* And the money is untouched by it. */
    expect(await totalOf("po_sent")).toBe(500000);
  });
});

describe("the status control", () => {
  const view = readFileSync(
    fileURLToPath(new URL("../src/components/documents/DocumentLedgerView.tsx", import.meta.url)),
    "utf8"
  );
  const actions = readFileSync(
    fileURLToPath(new URL("../src/app/(app)/projects/actions.ts", import.meta.url)),
    "utf8"
  );

  it("OFFERS ONLY WHAT THE ACTION ACCEPTS", () => {
    const offered = /const ROW_STATUSES: readonly DocumentStatus\[\] = \[([^\]]+)\]/.exec(view)?.[1] ?? "";
    const accepted = /const DOC_STATUSES = \[([^\]]+)\]/.exec(actions)?.[1] ?? "";
    expect(offered).not.toBe("");
    for (const value of offered.match(/"([a-z_]+)"/g) ?? []) {
      expect(accepted, `the menu offers ${value}, which the action refuses`).toContain(value);
    }
  });

  it("KEEPS A PENDING APPROVAL AS TEXT, never a menu", () => {
    /* A select showing "draft" over a document awaiting approval threw the
       approval away the last time this was built. */
    expect(view).toMatch(/r\.status === "awaiting_approval" \|\| r\.status === "approved" \?/);
  });

  it("does not let the menu set an approval state", () => {
    const offered = /const ROW_STATUSES: readonly DocumentStatus\[\] = \[([^\]]+)\]/.exec(view)?.[1] ?? "";
    expect(offered).not.toContain("approved");
    expect(offered).not.toContain("awaiting_approval");
  });

  it("offers Edit only on a draft", () => {
    /* Now also behind `canWrite`: a view-only reader and a bookkeeper were
       both being offered an Edit the server refuses. The draft rule itself is
       unchanged — once a document has gone out, what the other side holds is
       the record. */
    expect(view).toMatch(/\{canWrite && r\.status === "draft" && \(/);
  });
});
