import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * How the quotes and purchase-order pages are wired.
 *
 * The figures themselves are checked against a database in
 * `document-ledger.test.ts`. What these hold is the wiring that keeps them
 * trustworthy, each line of which was a decision:
 *
 *  - ONE create path. The pages post to `createDocumentAction`, the same
 *    action the project screen uses, because that action already refuses a
 *    quantity it cannot read and rounds a decimal to the three places the
 *    column keeps. A second create path would be a second chance to lose the
 *    half day in "3.5 days at R12,000.50".
 *  - Cents shown wherever there are any. R42,001.75 rendered as R42,002 is 25c
 *    a client's copy will not agree with.
 *  - The status menu offers only what somebody may choose when RAISING one,
 *    and only values the action accepts.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const view = read("../src/components/documents/DocumentLedgerView.tsx");
const quotes = read("../src/app/(app)/quotes/page.tsx");
const orders = read("../src/app/(app)/purchase-orders/page.tsx");
const actions = read("../src/app/(app)/projects/actions.ts");

describe("creating one", () => {
  it("USES THE SAME ACTION THE PROJECT SCREEN USES, not a second one", () => {
    expect(view).toMatch(/createDocumentAction,?\s*\n?[\s\S]{0,120}from "@\/app\/\(app\)\/projects\/actions"/);
    expect(view).toMatch(/useKeptForm<FormState>\(createDocumentAction/);
  });

  it("sends the quantity and price as typed, and totals nothing itself", () => {
    /* No arithmetic in the form. A subtotal drawn here would be a second
       opinion about a number the server already computes from the lines. */
    expect(view).not.toMatch(/quantity\s*\*\s*unit/i);
    expect(view).not.toMatch(/reduce\(\(.*total/i);
  });

  it("lets a decimal be typed at all", () => {
    /* `type="number"` with a default step refuses 3.5 in some browsers and
       silently rounds in others, which is where the half day went last time. */
    expect(view).toMatch(/name="lineQuantity"[\s\S]{0,200}inputMode="decimal"/);
    expect(view).toMatch(/name="lineUnit"[\s\S]{0,200}inputMode="decimal"/);
  });

  it("OFFERS ONLY STATUSES THE ACTION WILL ACCEPT", () => {
    /* A control whose options disagree with its own data has shipped here
       before: the project screen drew a quote as "draft" because its select
       had no option for the status it held, and one press of Update threw a
       pending approval away. */
    const offered = /const CREATE_STATUSES = \[([^\]]+)\]/.exec(view)?.[1] ?? "";
    const accepted = /const DOC_STATUSES = \[([^\]]+)\]/.exec(actions)?.[1] ?? "";
    expect(offered, "the form offers no statuses").not.toBe("");
    for (const value of offered.match(/"([a-z_]+)"/g) ?? []) {
      expect(accepted, `the form offers ${value}, which the action refuses`).toContain(value);
    }
  });

  it("does not offer a status that belongs to the approval flow", () => {
    const offered = /const CREATE_STATUSES = \[([^\]]+)\]/.exec(view)?.[1] ?? "";
    expect(offered).not.toContain("awaiting_approval");
    expect(offered).not.toContain("approved");
  });

  it("makes somebody choose the job rather than defaulting to one", () => {
    /* A quotation filed against the wrong job is money on the wrong margin,
       and nothing on screen would say so. */
    expect(view).toMatch(/name="dealId"[\s\S]{0,120}required/);
    expect(view).toMatch(/Choose a job/);
  });
});

describe("what the figures are shown with", () => {
  it("SHOWS CENTS WHEREVER THERE ARE ANY", () => {
    expect(view).toMatch(/format\(cents, "exact"\)/);
  });

  it("never falls back to the rounding style for a document total", () => {
    /* `whole` is right on a dashboard tile and wrong on a page of documents
       somebody signs. */
    expect(view).not.toMatch(/format\([^)]*"whole"\)/);
  });
});

describe("the two pages", () => {
  it("read their own kind, and nothing else", () => {
    expect(quotes).toMatch(/documentLedger\(q, "quote"\)/);
    expect(orders).toMatch(/documentLedger\(q, "purchase_order"\)/);
    expect(quotes).not.toMatch(/purchase_order/);
    expect(orders).not.toMatch(/"quote"/);
  });

  it("suggest the next number from the workspace's own sequence", () => {
    expect(quotes).toMatch(/nextDocumentNumber\(q, "quote", LEDGERS\.quote\.prefix\)/);
    expect(orders).toMatch(/nextDocumentNumber\(q, "purchase_order", LEDGERS\.purchase_order\.prefix\)/);
  });

  it("DATE FROM THE BUSINESS'S OWN DAY, not the server's", () => {
    /* A quotation raised at 01:00 in Johannesburg must not be dated
       yesterday, which is what the server's UTC day would call it. */
    for (const page of [quotes, orders]) {
      expect(page).toMatch(/instantToWallClock\(new Date\(\)\.toISOString\(\), settings\.timeZone\)/);
    }
  });

  it("are not cached, so a document raised a minute ago is in the list", () => {
    for (const page of [quotes, orders]) {
      expect(page).toMatch(/export const dynamic = "force-dynamic"/);
    }
  });
});

describe("where they sit in the navigation", () => {
  const nav = read("../src/components/shell/nav.ts");

  it("hang under Projects without living under its URL", () => {
    /* `/projects/[id]` already owns that space: a static child wins over the
       dynamic segment, and a project whose id matched would become
       unreachable with nothing on screen to explain why. */
    expect(nav).toMatch(/href: "\/quotes"/);
    expect(nav).toMatch(/href: "\/purchase-orders"/);
    expect(nav).not.toMatch(/href: "\/projects\/quotes"/);
    expect(nav).not.toMatch(/href: "\/projects\/purchase-orders"/);
  });
});
