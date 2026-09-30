import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The gate a price passes through on its way to a client.
 *
 * The rule this product keeps: an agent may draft and revise, a NAMED human
 * approves, and only then does anything leave for a client. It was enforced in
 * one place because there was one door — the chat flow, where `approveQuote`
 * moves a quotation out of `awaiting_approval`.
 *
 * A second door now exists: quotations typed by hand on the quotes page, which
 * are `draft` and could never have reached that transition at all. These check
 * that the second door has the same lock, and that there is still only one
 * piece of delivery code behind both.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const delivery = read("../src/server/quote-delivery.ts");
const sendAction = read("../src/app/(app)/quotes/actions.ts");
const chatActions = read("../src/app/(app)/chat/actions.ts");
const view = read("../src/components/documents/DocumentLedgerView.tsx");
const createAction = read("../src/app/(app)/projects/actions.ts");

describe("there is one way out, not two", () => {
  it("BOTH DOORS USE THE SAME DELIVERY CODE", () => {
    /* Two copies of the last gate before a price reaches a customer is one
       gate. The chat flow's own helper moved into this module rather than
       being copied for the new page. */
    expect(sendAction).toMatch(/from "@\/server\/quote-delivery"/);
    expect(chatActions).toMatch(/from "@\/server\/quote-delivery"/);
  });

  it("the delivery code still refuses anything not approved", () => {
    expect(delivery).toMatch(/!quote\.approvedAt \|\| quote\.status !== "approved"/);
    expect(delivery).toMatch(/has not been approved, so nothing was sent/);
  });

  it("neither action reimplements the queueing", () => {
    /* If a call site queues QUOTE_EMAIL itself it has stepped around the
       checks above. */
    expect(sendAction).not.toMatch(/QUOTE_EMAIL/);
    expect(chatActions).not.toMatch(/queueJob\(/);
  });
});

describe("approving by hand", () => {
  it("RECORDS WHO APPROVED IT, not just that it was approved", () => {
    /* A client querying a price six weeks later gets a name rather than
       "the system". */
    expect(sendAction).toMatch(/approved_by_user_id = \$3/);
    expect(sendAction).toMatch(/approved_at = now\(\)/);
    expect(sendAction).toMatch(/logWrite\("approve", "quote"/);
  });

  it("DOES NOT REASSIGN AN APPROVAL SOMEBODY ELSE MADE", () => {
    /* Re-stamping on a second press would quietly move the decision to
       whoever pressed Send. */
    expect(sendAction).toMatch(/if \(quote\.status !== "approved"\)/);
  });

  it("only promotes from states a quotation can be sent from", () => {
    expect(sendAction).toMatch(/status IN \('draft', 'awaiting_approval'\)/);
    /* And refuses the rest with a reason rather than silently doing nothing. */
    expect(sendAction).toMatch(/there is nothing to send/);
  });

  it("refuses one that has already gone", () => {
    expect(sendAction).toMatch(/has already been sent/);
  });
});

describe("what the screen offers", () => {
  it("shows Send only where sending is possible", () => {
    expect(view).toMatch(/const SENDABLE_QUOTE: readonly DocumentStatus\[\] = \["draft", "awaiting_approval", "approved"\]/);
    expect(view).toMatch(/SENDABLE_QUOTE : SENDABLE_ORDER\)\.includes\(r\.status\)/);
  });

  it("NEVER OFFERS SEND ON ONE THAT HAS ALREADY GONE", () => {
    /* Two deliveries and an argument about an invoice. The action refuses
       it again — a control is tidiness, the refusal in the server is the
       rule — but offering the button at all invites the second press. */
    expect(view).toMatch(/&& !r\.sentAt/);
  });

  it("lets an order go from a wider set of states than a quotation", () => {
    /* A quotation must be approved before it leaves. An order is counted in
       a project's committed money from the moment it is drafted, so
       drafting one WAS the decision. */
    expect(view).toMatch(/const SENDABLE_ORDER: readonly DocumentStatus\[\] = \["draft", "approved", "accepted"\]/);
  });
});

describe("a quotation knows who it is addressed to", () => {
  it("LINKS THE JOB'S CLIENT, so an approved quotation can actually be sent", () => {
    /* `party` is a typed name; `party_contact_id` is the person it can be
       emailed to. Without it a quotation was approved and then refused with
       "no email address on file" about somebody who has one. */
    expect(createAction).toMatch(/const partyContactId = kind === "purchase_order" \? null : deal\.contact_id;/);
    expect(createAction).toMatch(/party_contact_id, party_email\)/);
  });

  it("does not address a purchase order to the client paying for the work", () => {
    expect(createAction).toMatch(/kind === "purchase_order" \? null/);
  });
});
