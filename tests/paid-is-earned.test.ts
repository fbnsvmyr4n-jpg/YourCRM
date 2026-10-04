/*
   "Paid" is not a word anybody types.

   An invoice reaches that status because money was recorded against it — by the
   provider's webhook or by a person entering a transfer — and never because it
   was chosen from a menu. The menu could only ever set the word: no amount, no
   date, no method, nobody's name. An invoice could read "paid" with an empty
   list of payments behind it, so the figure on Reports and the status on the
   document disagreed by exactly the amount nobody had entered, and a client who
   paid half could only be recorded as having paid all or none.

   These hold the two halves of that: no screen offers the word, and the action
   behind those screens refuses it whatever a hand-made request asks for.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");

const actions = read("src/app/(app)/projects/actions.ts");
const ledger = read("src/components/documents/DocumentLedgerView.tsx");
const detail = read("src/app/(app)/projects/[id]/ProjectDetail.tsx");

describe("the status menu", () => {
  it("cannot express paid, on the server", () => {
    const list = actions.match(/const DOC_STATUSES = \[([\s\S]*?)\] as const;/);
    expect(list, "DOC_STATUSES is still declared").toBeTruthy();
    expect(list![1]).not.toContain("paid");
    /* The rest of the menu is untouched — this removed one word, not a feature. */
    for (const kept of ["draft", "sent", "accepted", "declined", "cancelled"]) {
      expect(list![1]).toContain(kept);
    }
  });

  it("says where to go instead, rather than falling through to 'choose a status'", () => {
    expect(actions).toMatch(/formData\.get\("status"\) === "paid"/);
    expect(actions).toMatch(/Record the payment instead/);
  });

  it("will not rewind an invoice that has money recorded against it", () => {
    expect(actions).toMatch(/'awaiting_approval', 'approved', 'paid'/);
    expect(actions).toMatch(/Correct the payment, not the status/);
  });

  it("is not offered on either screen that lists documents", () => {
    const rowStatuses = ledger.match(/const ROW_STATUSES: readonly DocumentStatus\[\] = \[([\s\S]*?)\];/);
    expect(rowStatuses, "ROW_STATUSES is still declared").toBeTruthy();
    expect(rowStatuses![1]).not.toContain('"paid"');

    /* The project page builds its own options inline. Matched on the array that
       feeds the select rather than on the file, so a `doc.status === "paid"`
       elsewhere on the page — of which there are several, legitimately — does
       not make this pass or fail for the wrong reason. */
    const inline = detail.match(/\{\["draft", "sent",([\s\S]*?)\]\.map/);
    expect(inline, "the project page still builds its status options inline").toBeTruthy();
    expect(inline![1]).not.toContain('"paid"');
  });
});

describe("recording a payment", () => {
  it("is finance's desk, checked in the action and not only in the screen", () => {
    const fn = actions.slice(actions.indexOf("export async function recordPaymentAction"));
    expect(fn).toMatch(/canSettleInvoice\(q\.ctx\.role\)/);
    /* Money, so IT is refused by the gate rather than by a check written here. */
    expect(fn).toMatch(/\{ money: true \}/);
  });

  it("says every outcome out loud, including the ones that changed nothing", () => {
    const fn = actions.slice(actions.indexOf("export async function recordPaymentAction"));
    for (const outcome of ["ignored", "already_recorded", "paid"]) {
      expect(fn).toContain(outcome);
    }
  });
});
