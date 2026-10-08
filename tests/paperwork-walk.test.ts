/*
   Job → quotation → approve → accept → invoice, walked as the salesperson.

   Three defects, each found by taking the next obvious step rather than by
   reading the code. All three are the same family: the screen and the database
   disagreeing, or the product knowing something and not using it.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/* Comments stripped before matching. Four guards this week have passed or
   failed against the PROSE EXPLAINING a fix rather than the fix itself. */
const read = (p: string) =>
  readFileSync(`${process.cwd()}/${p}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const projectDetail = read("src/app/(app)/projects/[id]/ProjectDetail.tsx");
const ledger = read("src/components/documents/DocumentLedgerView.tsx");
const projectActions = read("src/app/(app)/projects/actions.ts");

describe("picking a rate off the price list", () => {
  /*
     A name identified a price until the day two suppliers could both sell
     paving stone — which is exactly what the per-supplier price list was built
     to allow. The quote line picker still keyed on the name and did
     `priceItems.find(name === typed)`, so FIRST MATCH WON.

     The demo list holds paving stone at R450 from nobody in particular and at
     R510 from Stone Yard. Picking the Stone Yard row filled R450, silently.
     Over forty square metres that is R2,400 wrong on the quotation, and nothing
     on the screen said which of the two had been used.
  */
  it("TELLS TWO PRICES OF THE SAME NAME APART", () => {
    expect(projectDetail).toMatch(/function labelFor\(item: PickableItem, ambiguous: ReadonlySet<string>\)/);
    /* The supplier only where the name is ambiguous — hanging it off every row
       would put noise on forty items to solve the rare one. */
    expect(projectDetail).toMatch(
      /if \(!ambiguous\.has\(item\.name\.trim\(\)\.toLowerCase\(\)\)\) return item\.name;/
    );
  });

  it("matches on the OPTION, which is unique, not the name, which is not", () => {
    expect(projectDetail).toMatch(/labelFor\(p, ambiguousNames\)\.toLowerCase\(\) === typed/);
  });

  it("REFUSES TO GUESS when an ambiguous name is typed by hand", () => {
    /* Two prices under one name and nothing to say which was meant. Filling
       either is the original bug wearing a different hat, so it fills neither
       and the person types the rate they intend. */
    expect(projectDetail).toMatch(/byName\.length === 1 \? byName\[0\] : null/);
  });

  it("writes only the NAME onto the line, never the supplier", () => {
    /* The label exists to tell two rows apart in a picker. The client reads the
       finished quotation, and "Paving stone · Stone Yard" is this workspace's
       bookkeeping leaking onto it. */
    expect(projectDetail).toMatch(/if \(e\.target\.value !== match\.name\) e\.target\.value = match\.name;/);
  });
});

describe("the total on the form that is writing the quotation", () => {
  /*
     The form had none. A quotation was typed line by line, saved, and only then
     did a figure appear — so the one number the client cares about, and the one
     the person writing it is working towards, was the one thing they could not
     see until it was too late to adjust.
  */
  it("USES THE SAME VAT RULE the finished document does", () => {
    /* Not a second implementation of the same sum. `vatBreakdown` is what the
       printed sheet, the emailed copy and the pay page all ask, so the form and
       the document agree by construction. */
    expect(projectDetail).toMatch(/vatBreakdown\(subtotalCents, vat\.rateBp, vat\.inclusive\)/);
  });

  it("reads the FORM, so it cannot show a figure the save disagrees with", () => {
    /* The rows are uncontrolled — the price-list picker writes a rate straight
       into a row's inputs — so a mirrored copy in state would have to be told
       about that too. One source of truth, and it is the one submitted. */
    expect(projectDetail).toMatch(/onInput=\{\(e\) => retotal\(e\.currentTarget\)\}/);
    expect(projectDetail).toMatch(/form\.querySelectorAll<HTMLInputElement>\('input\[name="lineQuantity"\]'\)/);
  });

  it("rounds per line, the way the server stores them", () => {
    /* Summing in floats and rounding once at the end is how a form ends up a
       cent away from the document it just saved. */
    expect(projectDetail).toMatch(/subtotalCents \+= Math\.round\(qty \* unit \* 100\);/);
  });
});

describe("a quotation that has been approved", () => {
  /*
     "Send" on a workspace with no mail domain approves the quotation and says,
     honestly, that nothing was sent — so EVERY quotation lands in `approved`
     until Resend is configured, which is every workspace today.

     `approved` is not one of the statuses the menu can express, so the menu was
     hidden and the server refused the change as well. The client says yes and
     there is nothing to press. The walk stopped here.
  */
  it("SHOWS ITS REAL STATUS in the menu, disabled rather than absent", () => {
    expect(ledger).toMatch(/\{!ROW_STATUSES\.includes\(r\.status\) && \(/);
    expect(ledger).toMatch(/<option value=\{r\.status\} disabled className="capitalize">/);
  });

  it("keeps the menu, where only a document AWAITING approval loses it", () => {
    /* The two were treated as one state and are not. Awaiting approval means
       nobody has approved it, and picking its outcome from a menu is how an
       approval gets skipped. Approved means a named person already did. */
    expect(ledger).toMatch(/\) : !canWrite \|\| r\.status === "awaiting_approval" \? \(/);
  });

  it("may move FORWARD on the server, and never back to draft", () => {
    /* Returning an approved document to draft is the one move that throws an
       approval away — which is what the original blanket refusal was for. */
    expect(projectActions).toMatch(/AND status NOT IN \('awaiting_approval', 'paid'\)/);
    expect(projectActions).toMatch(/AND NOT \(status = 'approved' AND \$3 = 'draft'\)/);
  });

  it("says what that would cost, rather than naming a rule", () => {
    expect(projectActions).toMatch(
      /is already approved\. Moving it back to draft would throw that approval away/
    );
  });
});

describe("the status menu after a status changes", () => {
  /*
     Marking Q-1042 accepted left the database saying `accepted` and the menu
     saying `Draft`.

     `defaultValue` is read once, when the element mounts. React reuses the same
     `<select>` across re-renders, so the DOM kept what was there before — and
     once the option list changed shape, it fell back to its first option. It
     had always been fragile; the disabled option made it visible.

     A screen disagreeing with the database about money paperwork is worse than
     one that refuses to change it, because nothing announces it.
  */
  it("IS REMOUNTED WHEN THE FACT CHANGES, so it cannot show a stale word", () => {
    const select = ledger.slice(ledger.indexOf('<select\n                      name="status"'));
    expect(select.slice(0, 400)).toMatch(/key=\{r\.status\}/);
    expect(select.slice(0, 400)).toMatch(/defaultValue=\{r\.status\}/);
  });
});
