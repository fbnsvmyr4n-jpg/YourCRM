import { describe, expect, it } from "vitest";
import { invoiceBilled, invoicePaid, projectMoney } from "../src/server/stage-money";
import type { ProjectDocument } from "../src/server/repos/projects";

/**
 * The money strip at the top of a project.
 *
 * It answered three questions — what the job is worth, what was agreed, what
 * has been ordered — and not the two a business chases every week: what has
 * been billed, and what has come in. Invoicing already existed; nothing on the
 * project said how much of the agreed price had been asked for.
 *
 * Every figure below was worked out by hand before the code ran.
 */

const doc = (
  id: string,
  kind: ProjectDocument["kind"],
  status: ProjectDocument["status"],
  totalCents: number
): ProjectDocument => ({
  id,
  kind,
  number: id.toUpperCase(),
  status,
  party: null,
  issuedOn: null,
  dueOn: null,
  notes: null,
  sentAt: null,
  fromRetainer: false,
  lines: [
    { id: `${id}-l`, description: id, quantity: 1, unitCents: totalCents, totalCents, projectTaskId: null },
  ],
  totalCents,
});

describe("what counts as billed", () => {
  it("counts an invoice once it has left for the client, and not before", () => {
    for (const status of ["sent", "accepted", "paid"] as const) {
      expect(invoiceBilled(status), status).toBe(true);
    }
    /* A draft, or one approved whose email never went, has not been asked for.
       Counting it would say money is on its way that nobody has requested. */
    for (const status of ["draft", "awaiting_approval", "approved", "declined", "cancelled"] as const) {
      expect(invoiceBilled(status), status).toBe(false);
    }
  });

  it("counts an invoice as paid only when it says so", () => {
    expect(invoicePaid("paid")).toBe(true);
    for (const status of ["sent", "accepted", "draft", "approved", "cancelled"] as const) {
      expect(invoicePaid(status), status).toBe(false);
    }
  });
});

describe("the whole job", () => {
  /*
     A crane job, worked out by hand:
       quote Q-1  accepted   $1,350,000.00
       quote Q-2  sent       $   200,000.00   — a hope, not counted
       PO   PO-1  sent       $   600,000.00
       PO   PO-2  cancelled  $    50,000.00   — called off, not counted
       inv  I-1   paid       $   400,000.00
       inv  I-2   sent       $   300,000.00
       inv  I-3   draft      $   650,000.00   — not asked for yet
       inv  I-4   cancelled  $   100,000.00   — withdrawn

     quoted 1,350,000   committed 600,000   margin 750,000
     invoiced 700,000   paid 400,000        outstanding 300,000
  */
  const job = [
    doc("q1", "quote", "accepted", 135_000_000),
    doc("q2", "quote", "sent", 20_000_000),
    doc("po1", "purchase_order", "sent", 60_000_000),
    doc("po2", "purchase_order", "cancelled", 5_000_000),
    doc("i1", "invoice", "paid", 40_000_000),
    doc("i2", "invoice", "sent", 30_000_000),
    doc("i3", "invoice", "draft", 65_000_000),
    doc("i4", "invoice", "cancelled", 10_000_000),
  ];

  it("MATCHES THE FIGURES WORKED OUT BY HAND", () => {
    expect(projectMoney(job)).toEqual({
      quotedCents: 135_000_000,
      committedCents: 60_000_000,
      marginCents: 75_000_000,
      invoicedCents: 70_000_000,
      paidCents: 40_000_000,
      outstandingCents: 30_000_000,
    });
  });

  it("never adds an invoice to what was quoted", () => {
    /* An invoice is the same money as its quotation, seen later. Adding it
       would say the client agreed to pay twice. */
    const billedInFull = [
      doc("q1", "quote", "accepted", 100_000),
      doc("i1", "invoice", "paid", 100_000),
    ];
    const m = projectMoney(billedInFull);
    expect(m.quotedCents, "the invoice was counted as more quoted work").toBe(100_000);
    expect(m.invoicedCents).toBe(100_000);
    expect(m.outstandingCents).toBe(0);
  });

  it("does not count an invoice as money owed to suppliers either", () => {
    const m = projectMoney([doc("i1", "invoice", "sent", 90_000)]);
    expect(m.committedCents).toBe(0);
    expect(m.invoicedCents).toBe(90_000);
  });

  it("uses the same quote and order rules as the per-stage figures", () => {
    /* The header used to carry its own copy of these. Two definitions of
       "committed" on one screen would be worse than none. */
    const m = projectMoney([
      doc("q", "quote", "paid", 1_000),
      doc("q-sent", "quote", "sent", 9_999),
      doc("po-draft", "purchase_order", "draft", 300),
      doc("po-declined", "purchase_order", "declined", 7_777),
    ]);
    expect(m.quotedCents).toBe(1_000);
    expect(m.committedCents).toBe(300);
  });

  it("leaves margin empty until there is something on both sides", () => {
    expect(projectMoney([doc("q", "quote", "accepted", 5_000)]).marginCents).toBeNull();
    expect(projectMoney([doc("po", "purchase_order", "sent", 5_000)]).marginCents).toBeNull();
    expect(projectMoney([]).marginCents).toBeNull();
    // And it can go negative: a loss is a fact worth showing.
    expect(
      projectMoney([doc("q", "quote", "accepted", 1_000), doc("po", "purchase_order", "sent", 1_500)])
        .marginCents
    ).toBe(-500);
  });

  it("is all zeros for a job with no documents, not undefined", () => {
    expect(projectMoney([])).toEqual({
      quotedCents: 0,
      committedCents: 0,
      marginCents: null,
      invoicedCents: 0,
      paidCents: 0,
      outstandingCents: 0,
    });
  });
});
