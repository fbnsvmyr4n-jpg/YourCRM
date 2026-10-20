/*
   Taking money back off a bill.

   Until this existed the only ways to correct an invoice a client already had
   were to edit it — rewriting a document they are holding a copy of — or to
   cancel it and raise another, which throws away the history of what was
   actually agreed.

   Two properties carry the whole feature, and both are easy to get wrong in a
   way no screen would show:

   1. A DRAFT credit note reduces nothing. Somebody part-way through typing
      must not move what a client owes, or the outstanding figure is one that
      moves back.

   2. An invoice is settled by MONEY, never by a credit alone. Crediting an
      invoice to zero and marking it "paid" would put revenue on the books that
      nobody ever received.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";
import { owedCents } from "../src/server/vat";

/* Comments stripped before matching: guards in this repo have repeatedly
   matched the PROSE explaining a fix rather than the fix itself. */
const read = (p: string) =>
  readFileSync(`${process.cwd()}/${p}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let credits: typeof import("../src/server/repos/credits");
let raiseCreditNote: typeof import("../src/server/credit-note").raiseCreditNote;
let payments: typeof import("../src/server/repos/payments");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  credits = await import("../src/server/repos/credits");
  ({ raiseCreditNote } = await import("../src/server/credit-note"));
  payments = await import("../src/server/repos/payments");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

/** R15,000 of paving, billed on INV-1002, which the client already has. */
const INVOICE_CENTS = 1500000;

/**
 * One sent invoice, and a draft one beside it.
 *
 * The draft is not spare scenery — it is the case `raiseCreditNote` refuses,
 * and a fixture that could not produce it would make the refusal untestable.
 */
const seedWith = (rateBp: number, inclusive: boolean) =>
  db.seed(`
    DELETE FROM invoice_payments; DELETE FROM activities;
    DELETE FROM document_lines; DELETE FROM documents;
    DELETE FROM price_items; DELETE FROM suppliers;
    DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO settings (sub_account_id, currency, vat_rate_bp, prices_include_vat)
      VALUES ('${TENANT_A}', 'ZAR', ${rateBp}, ${inclusive})
      ON CONFLICT (sub_account_id) DO UPDATE SET
        currency = 'ZAR', vat_rate_bp = ${rateBp}, prices_include_vat = ${inclusive};
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('ct_ben', '${TENANT_A}', 'Ben', 'Cole', 'ben@cole.test');
    INSERT INTO deals (id, sub_account_id, title, value_cents, stage, contact_id) VALUES
      ('d_paving', '${TENANT_A}', 'Paving — phase 1', 0, 'won', 'ct_ben');
    INSERT INTO suppliers (id, sub_account_id, name) VALUES
      ('sup_stone', '${TENANT_A}', 'Stone Yard');
    INSERT INTO price_items (id, sub_account_id, name, unit, unit_cents, track_stock, supplier_id) VALUES
      ('pi_stone', '${TENANT_A}', 'Paving stone', 'm²', 50000, TRUE, 'sup_stone');
    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party_contact_id, sent_at) VALUES
      ('inv-sent',  '${TENANT_A}', 'd_paving', 'invoice', 'INV-1002', 'sent',  'ct_ben', now()),
      ('inv-draft', '${TENANT_A}', 'd_paving', 'invoice', 'INV-1003', 'draft', 'ct_ben', NULL);
    INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position, price_item_id) VALUES
      ('l_sent',  '${TENANT_A}', 'inv-sent',  'Paving — phase 1', 1, ${INVOICE_CENTS}, 0, 'pi_stone'),
      ('l_draft', '${TENANT_A}', 'inv-draft', 'Paving — phase 2', 1, ${INVOICE_CENTS}, 0, 'pi_stone');
  `);

beforeEach(() => seedWith(0, false));

/** Giving it to the client — the moment it starts coming off the bill. */
const issue = (id: string) =>
  inA((q) =>
    q.rows(`UPDATE documents SET status = 'sent' WHERE sub_account_id = $1 AND id = $2`, [
      TENANT_A,
      id,
    ])
  );

const creditedOnInvoice = () => inA((q) => credits.creditedFor(q, "inv-sent"));

const statusOf = async (id: string) =>
  (
    await inA((q) =>
      q.one<{ status: string }>(
        `SELECT status FROM documents WHERE sub_account_id = $1 AND id = $2`,
        [TENANT_A, id]
      )
    )
  )?.status;

describe("raising one", () => {
  it("copies the invoice's lines, INCLUDING which price item they came from", async () => {
    /*
       Starting from the invoice's own lines is how somebody actually works —
       "they are not paying for the scaffold hire" — and retyping them is the
       step where a credit note ends up citing a different rate from the
       invoice it corrects.

       The price item travels because a name is not an identity: two suppliers
       can both sell "Paving stone", and matching the description back would
       put the goods on whichever shelf came first. That exact bug cost a
       quotation the wrong rate on 7 Oct.
    */
    const result = await inA((q) => raiseCreditNote(q, "inv-sent"));
    expect(result).toMatchObject({ number: "CN-1001", forInvoice: "INV-1002", totalCents: INVOICE_CENTS });
    if ("error" in result) return;

    const lines = await inA((q) =>
      q.rows<{ description: string; unit_cents: string; price_item_id: string | null }>(
        `SELECT description, unit_cents::text AS unit_cents, price_item_id
           FROM document_lines WHERE sub_account_id = $1 AND document_id = $2`,
        [TENANT_A, result.creditNoteId]
      )
    );
    expect(lines).toEqual([
      { description: "Paving — phase 1", unit_cents: String(INVOICE_CENTS), price_item_id: "pi_stone" },
    ]);
  });

  it("is BORN A DRAFT, because raising one and giving it out are two decisions", async () => {
    const result = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in result) throw new Error(result.error);
    expect(await statusOf(result.creditNoteId)).toBe("draft");
  });

  it("names the invoice on its face, so the pair can be matched by whoever gets them", async () => {
    const result = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in result) throw new Error(result.error);
    const note = await inA((q) =>
      q.one<{ notes: string; credits_document_id: string }>(
        `SELECT notes, credits_document_id FROM documents WHERE sub_account_id = $1 AND id = $2`,
        [TENANT_A, result.creditNoteId]
      )
    );
    expect(note).toEqual({ notes: "Credit against INV-1002.", credits_document_id: "inv-sent" });
  });

  it("REFUSES A DRAFT INVOICE, and says what to do instead", async () => {
    /* A credit note corrects a document the client is holding. Against a draft
       it is a correction to something nobody has seen — change it directly. */
    const result = await inA((q) => raiseCreditNote(q, "inv-draft"));
    expect(result).toEqual({
      error:
        "INV-1003 is still a draft. Change it directly — a credit note is for an invoice the client already has.",
    });
  });

  it("refuses a second one once the bill is credited in full", async () => {
    const first = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in first) throw new Error(first.error);
    /* Only once it is ISSUED, because only then has anything come off. */
    await issue(first.creditNoteId);

    expect(await inA((q) => raiseCreditNote(q, "inv-sent"))).toEqual({
      error: "INV-1002 has already been credited in full.",
    });
  });

  it("still allows a second one while the first is only a draft", async () => {
    /* The mirror of the rule above, and the one that would be lost by checking
       the line total rather than what has actually been taken back. */
    const first = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in first) throw new Error(first.error);
    expect(await inA((q) => raiseCreditNote(q, "inv-sent"))).toMatchObject({ number: "CN-1002" });
  });
});

describe("what comes off the bill", () => {
  it("IS NOTHING WHILE IT IS A DRAFT", async () => {
    /* The property the whole feature rests on. An outstanding figure that
       moved because of an unfinished document is one that moves back. */
    const result = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in result) throw new Error(result.error);
    expect(await creditedOnInvoice()).toBe(0);

    await issue(result.creditNoteId);
    expect(await creditedOnInvoice()).toBe(INVOICE_CENTS);
  });

  it("is nothing again once it is called off", async () => {
    const result = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in result) throw new Error(result.error);
    await issue(result.creditNoteId);
    await inA((q) =>
      q.rows(`UPDATE documents SET status = 'cancelled' WHERE sub_account_id = $1 AND id = $2`, [
        TENANT_A,
        result.creditNoteId,
      ])
    );
    expect(await creditedOnInvoice()).toBe(0);
  });

  it("never counts another workspace's credit note", async () => {
    const result = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in result) throw new Error(result.error);
    await issue(result.creditNoteId);
    expect(await inB((q) => credits.creditedFor(q, "inv-sent"))).toBe(0);
  });

  it("answers the same for one invoice and for a whole ledger", async () => {
    /* Two queries exist because a ledger asked per row would be forty round
       trips to answer a question that is almost always "nothing". Two queries
       are two chances to disagree, so this pins them together. */
    const result = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in result) throw new Error(result.error);
    await issue(result.creditNoteId);

    const many = await inA((q) => credits.creditedForMany(q, ["inv-sent", "inv-draft"]));
    expect(many["inv-sent"]).toBe(await creditedOnInvoice());
    /* Absent rather than zero: this knows what has been credited, and the
       caller already knows which invoices it asked about. */
    expect(many).not.toHaveProperty("inv-draft");
  });
});

describe("settling a part-credited invoice", () => {
  const pay = (amountCents: number) =>
    inA((q) =>
      payments.recordManualPayment(q, {
        documentId: "inv-sent",
        amountCents,
        paidOn: "2026-10-20",
        method: "transfer",
      })
    );

  it("CLEARS ON THE REDUCED FIGURE — the client pays what they were asked for", async () => {
    /*
       The failure this prevents: an invoice part-credited and then paid in
       full sits unsettled for ever. The client has paid everything they owe,
       the overdue chase keeps firing every morning, and nothing on any screen
       explains the gap.
    */
    const result = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in result) throw new Error(result.error);
    /* Credit half of it: R7,500 off R15,000. */
    await inA((q) =>
      q.rows(`UPDATE document_lines SET unit_cents = 750000 WHERE sub_account_id = $1 AND document_id = $2`, [
        TENANT_A,
        result.creditNoteId,
      ])
    );
    await issue(result.creditNoteId);

    expect(await pay(750000)).toEqual({ outcome: "paid", number: "INV-1002" });
    expect(await statusOf("inv-sent")).toBe("paid");
  });

  it("CREDITING IT TO ZERO DOES NOT MARK IT PAID", async () => {
    /*
       Crediting an invoice to nothing and calling it paid would put revenue on
       the books that nobody received. It stays where it is; the ledger shows
       it as credited, which is the honest answer.

       ── What this does and does not prove ─────────────────────────────────
       It proves nothing marks an invoice paid except money arriving, which is
       the property that matters on screen. It does NOT exercise the
       `received > 0` clause in `settle`: both callers write a payment row of a
       verified positive amount before settling, so there is no path on which
       `settle` runs with nothing received. Mutation testing is how that came
       out — deleting the clause changed no behaviour and this test kept
       passing, which made its original name ("is never settled by a credit
       alone") a claim it was not checking.

       The clause stays as the guard for a third caller, and this comment is
       the record that it is defensive rather than load-bearing — so nobody
       later reads a green test as proof that it works.
    */
    const result = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in result) throw new Error(result.error);
    await issue(result.creditNoteId);

    expect(await creditedOnInvoice()).toBe(INVOICE_CENTS);
    expect(await statusOf("inv-sent")).toBe("sent");
    /* And no money was invented on the way. */
    expect(await inA((q) => payments.paidCents(q, "inv-sent"))).toBe(0);
  });

  it("a payment on a fully-credited invoice settles it, because nothing is owed", async () => {
    /* The reachable half of the rule above. They owe nothing and have paid
       something, so the invoice is done — and this is the case that would be
       silently wrong if the credit were ignored when working out what is due. */
    const result = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in result) throw new Error(result.error);
    await issue(result.creditNoteId);

    expect(await pay(100)).toEqual({ outcome: "paid", number: "INV-1002" });
  });

  it("CLEARS THE BILL ENTIRELY WHERE THE BUSINESS CHARGES VAT ON TOP", async () => {
    /*
       THE MONEY BUG THIS FILE EXISTS FOR, found by crediting a real invoice in
       the running app rather than by reading the code.

       R15,000 of lines is R17,250 owed at 15%, and a credit note for those
       same lines prints R17,250 too — it is a tax document like the invoice it
       corrects. So crediting the lot leaves NOTHING owed.

       What the code did was measure the credit NET and the invoice GROSS, so a
       client holding a credit note for R17,250 against an invoice for R17,250
       was shown as owing R2,250 — VAT on a charge taken back in full. It would
       have been chased for, and it was never owed.

       The first version of this test asserted 225000 and passed, which is the
       part worth remembering: a test written from the same misunderstanding as
       the code agrees with it.
    */
    await seedWith(1500, false);
    const result = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in result) throw new Error(result.error);
    await issue(result.creditNoteId);

    /* The credit note's own sheet says R17,250, and so does this. */
    expect(await creditedOnInvoice()).toBe(1725000);
    expect(owedCents(INVOICE_CENTS, 1500, false, await creditedOnInvoice())).toBe(0);
  });

  it("leaves exactly the uncredited part owing, tax and all", async () => {
    /* The partial case, which is the one that would hide a net/gross mix-up
       behind a plausible-looking number. Credit R5,000 of lines — R5,750 with
       VAT — off R17,250, and R11,500 is left. */
    await seedWith(1500, false);
    const result = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in result) throw new Error(result.error);
    await inA((q) =>
      q.rows(`UPDATE document_lines SET unit_cents = 500000 WHERE sub_account_id = $1 AND document_id = $2`, [
        TENANT_A,
        result.creditNoteId,
      ])
    );
    await issue(result.creditNoteId);

    expect(await creditedOnInvoice()).toBe(575000);
    expect(owedCents(INVOICE_CENTS, 1500, false, await creditedOnInvoice())).toBe(1150000);
    expect(await pay(1150000)).toEqual({ outcome: "paid", number: "INV-1002" });
  });

  it("refuses a further credit once the GROSS is covered, not the net", async () => {
    /*
       The refusal and the arithmetic have to agree, or the screen offers a
       control the server throws out. Driving this in the app is what exposed
       the bug: a second credit note was raised against an invoice already
       credited in full, because `already >= payable` was comparing R15,000
       against R17,250.
    */
    await seedWith(1500, false);
    const first = await inA((q) => raiseCreditNote(q, "inv-sent"));
    if ("error" in first) throw new Error(first.error);
    await issue(first.creditNoteId);

    expect(await inA((q) => raiseCreditNote(q, "inv-sent"))).toEqual({
      error: "INV-1002 has already been credited in full.",
    });
  });
});

describe("the four screens that work out what an invoice owes", () => {
  it("ALL ASK `owedCents`, so none of them can drift", () => {
    /* The settlement, the ledger, the project screen and the public pay page.
       Four copies of this arithmetic is four chances for a client to be shown
       one figure and charged another. */
    for (const path of [
      "src/server/repos/payments.ts",
      "src/server/document-ledger.ts",
      "src/server/repos/projects.ts",
      "src/server/pay/pay.ts",
    ]) {
      expect(read(path), `${path} works out what is owed by itself`).toMatch(/owedCents\(/);
    }
  });

  it("nets off credits rather than passing the gross and hoping", () => {
    for (const path of [
      "src/server/repos/payments.ts",
      "src/server/document-ledger.ts",
      "src/server/repos/projects.ts",
      "src/server/pay/pay.ts",
    ]) {
      expect(read(path), `${path} ignores credits`).toMatch(/credited(For|ForMany|Cents|)\b/);
    }
  });
});

describe("who may issue one", () => {
  /*
     THE DEAD END THIS CLOSES.

     Finance could RAISE a credit note and then had nothing to press. The
     ledger's only status control asks `canWrite` — "may change customer
     records" — which is correctly false for a bookkeeper, and
     `setDocumentStatusAction` goes through the CRM door for the same reason.
     So the document sat as a draft reducing nothing, raised by the one role
     whose job it is and unfinishable by them.

     The same mistake as the Credit button one commit earlier: a new control
     inheriting whatever gate the file already imported, rather than the
     ability of the role whose work it is.
  */
  const actions = read("src/app/(app)/projects/actions.ts");

  it("is the bookkeeper — so the action goes through the MONEY door", () => {
    const fn = actions.slice(actions.indexOf("export async function setCreditNoteStatusAction"));
    expect(fn.slice(0, fn.indexOf("\n}\n") + 3)).toMatch(/\{ money: true \}/);
  });

  it("is a SEPARATE action from the one that moves a quotation along", () => {
    /* Widening `setDocumentStatusAction` to the money door instead would have
       handed a bookkeeper every quotation and purchase order in the
       workspace. */
    expect(actions).toMatch(/export async function setDocumentStatusAction/);
    expect(actions).toMatch(/export async function setCreditNoteStatusAction/);
  });

  it("CANNOT TOUCH ANYTHING THAT IS NOT A CREDIT NOTE", () => {
    /* What keeps the money door narrow. Both statements name the kind, so
       neither a lookup nor the write can reach a quotation. */
    const fn = actions.slice(actions.indexOf("export async function setCreditNoteStatusAction"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    expect(body.match(/kind = 'credit_note'/g)?.length).toBe(2);
  });

  it("offers only the three words that mean anything on a credit note", () => {
    /* Not a quotation's five. Nobody accepts or declines a credit note — it is
       given, or it is not. */
    const ledger = read("src/components/documents/DocumentLedgerView.tsx");
    expect(ledger).toMatch(/CREDIT_STATUSES[^=]*=\s*\["draft", "sent", "cancelled"\]/);
    expect(ledger).toMatch(/statusChoices = isCredit \? CREDIT_STATUSES : ROW_STATUSES/);
  });
});
