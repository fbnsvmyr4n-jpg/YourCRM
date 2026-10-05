/*
   What a bookkeeper can actually reach.

   The access tiers were reworked into three — customer records, money, and
   running the machine — and the finance role has not been driven end to end
   since. Signing in as one found two things, and the second is the serious
   one.

   1. Every page told them "View only — you can see everything here, and
      changes are not saved". False: finance settles invoices and manages the
      billing. The shell was asking `canWrite`, which means "may change
      customer records" and is correctly false for them.

   2. THERE WAS NO INVOICES SCREEN AT ALL. Invoices lived only inside a job,
      and a job is customer work — the one place `canAccessCrm` keeps a
      bookkeeper out of. So the person whose whole job is the money coming in
      could open quotations and purchase orders and not a single invoice, while
      `canSettleInvoice` said they were the ones who confirm a payment. The
      capability existed and was unreachable.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canAccessCrm,
  canAccessMoney,
  canSettleInvoice,
  canWrite,
  isViewOnly,
} from "@/server/permissions";
import { LEDGERS } from "@/server/document-ledger";

const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");

describe("who is actually view-only", () => {
  it("is the viewer, and nobody else", () => {
    expect(isViewOnly("viewer")).toBe(true);
    for (const role of ["owner", "admin", "finance", "member"]) {
      expect(isViewOnly(role), `${role} is not view-only`).toBe(false);
    }
  });

  it("is a DIFFERENT question from whether somebody may write customer records", () => {
    /* Conflating them is what put the banner on a bookkeeper's screen. Finance
       and IT write plenty; they write elsewhere. */
    expect(canWrite("finance")).toBe(false);
    expect(isViewOnly("finance")).toBe(false);
    expect(canWrite("admin")).toBe(false);
    expect(isViewOnly("admin")).toBe(false);
  });

  it("is what the banner asks, so it is not shown to finance or IT", () => {
    const shell = read("src/components/shell/AppShell.tsx");
    expect(shell).toMatch(/\{isViewOnly\(user\.role\) && \(/);
    expect(shell).not.toMatch(/\{!canWrite\(user\.role\) && \(/);
  });
});

describe("the invoices ledger", () => {
  it("exists, which it did not", () => {
    expect(() => read("src/app/(app)/invoices/page.tsx")).not.toThrow();
    expect(LEDGERS.invoice).toMatchObject({ kind: "invoice", prefix: "INV", title: "Invoices" });
  });

  it("is opened by the MONEY tier, so a bookkeeper can and IT cannot", () => {
    const page = read("src/app/(app)/invoices/page.tsx");
    expect(page).toMatch(/money: true/);

    expect(canAccessMoney("finance")).toBe(true);
    expect(canAccessCrm("finance")).toBe(false);
    /* IT fixes the machine; what the business charges is not theirs to read. */
    expect(canAccessMoney("admin")).toBe(false);
  });

  it("puts the payment box where finance can reach it", () => {
    /* `canSettleInvoice` said finance confirms payments, and the only control
       that does it lived on a screen they cannot open. */
    expect(canSettleInvoice("finance")).toBe(true);
    const view = read("src/components/documents/DocumentLedgerView.tsx");
    expect(view).toMatch(/copy\.kind === "invoice" && r\.status !== "cancelled" && \(/);
    expect(view).toMatch(/<RecordPayment/);
  });

  it("is in the navigation as a money page", () => {
    const nav = read("src/components/shell/nav.ts");
    expect(nav).toMatch(/\{ label: "Invoices", href: "\/invoices", icon: Receipt, isMoney: true \}/);
  });

  it("does not offer a status menu on an invoice", () => {
    /* An invoice's status is a consequence of the payments recorded against
       it, never a word somebody picks — the same rule the job screen follows,
       and the reason `paid` is not in DOC_STATUSES. */
    const view = read("src/components/documents/DocumentLedgerView.tsx");
    const branch = view.indexOf('{copy.kind === "invoice" ? (');
    expect(branch, "the invoice branch is gone").toBeGreaterThan(-1);
  });
});

describe("the figures on it", () => {
  it("are made of PAYMENTS, not statuses", () => {
    /*
       Summing the totals of invoices marked paid produced two figures that
       contradicted the rows beneath them — "Outstanding R0" over a row saying
       R3,000 outstanding — because the status said paid while the payments
       fell short. Which is exactly what happens when VAT is switched on after
       an invoice was settled.
    */
    const ledger = read("src/server/document-ledger.ts");
    expect(ledger).toMatch(/countedCents \+= receivedCents;/);
    expect(ledger).toMatch(
      /if \(r\.status !== "cancelled"\) notCountedCents \+= Math\.max\(0, dueCents - receivedCents\);/
    );
  });

  it("owes against what the client OWES, VAT included", () => {
    /* The same `payableCents` the webhook settles by, so the figure on this
       screen is the figure that settles. */
    expect(read("src/server/document-ledger.ts")).toMatch(/payableCents\(totalCents, vatRateBp, pricesIncludeVat\)/);
  });

  it("says what it means in its own words, rather than a quote's", () => {
    /*
       The copy was three ternaries on `kind === "quote"`, so the day a third
       ledger arrived it opened saying "What you have committed to suppliers".
       A binary standing in for a set is a bug waiting for the third member.
    */
    expect(LEDGERS.invoice.blurb).toBe("What clients owe you, and what they have paid.");
    expect(LEDGERS.invoice.countedLabel).toBe("Received");
    expect(LEDGERS.invoice.notCountedLabel).toBe("Outstanding");
    for (const copy of Object.values(LEDGERS)) {
      expect(copy.blurb, `${copy.kind} has no blurb`).toBeTruthy();
      expect(copy.countedBlurb, `${copy.kind} has no countedBlurb`).toBeTruthy();
      expect(copy.notCountedBlurb, `${copy.kind} has no notCountedBlurb`).toBeTruthy();
    }
  });
});
