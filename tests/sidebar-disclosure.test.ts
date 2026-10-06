/*
   A nav row with pages under it has to SAY so.

   The defect: Quotes and Purchase orders live under Projects, and the only
   evidence they existed was arriving on Projects — the row looked identical to
   Contacts or Inbox from everywhere else in the product. Reaching a quotation
   from the contacts screen therefore cost a navigation to a page nobody wanted,
   purely to find the link to the one they did.

   The fix is a disclosure on any row that has children: it marks the row, and
   it opens the children where the reader stands rather than taking them
   somewhere. These hold both halves — that the control exists for every such
   row, and that it did not replace the old behaviour of opening the group you
   are already working in.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAV, visibleNav } from "@/components/shell/nav";

const sidebar = readFileSync(`${process.cwd()}/src/components/shell/Sidebar.tsx`, "utf8");

describe("rows with pages under them", () => {
  it("exist — otherwise this whole file is guarding nothing", () => {
    const parents = NAV.flatMap((s) => s.items).filter((i) => i.children?.length);
    expect(parents.length).toBeGreaterThan(0);
    /* Named, so that moving Quotes out from under Projects is a deliberate
       change to this test rather than a silent one. */
    expect(parents.map((p) => p.href)).toContain("/projects");
  });

  it("are not drawn at all for a reader who may not open the parent", () => {
    /*
       The combination that actually exists.

       Every role with CRM access also has money access, so "sees Projects but
       not Quotes" is a state this product cannot produce — asserting it would
       have been a fixture describing an impossible world, which is how a test
       comes to teach the wrong thing. The two real cases are a bookkeeper
       (money, no CRM) and IT (neither).
    */
    const forFinance = visibleNav({ crm: false, money: true, mail: true, ops: false }).flatMap(
      (s) => s.items
    );
    expect(forFinance.find((i) => i.href === "/projects")).toBeUndefined();
    /* Lifted to the top instead, so the disclosure is not what stands between
       a bookkeeper and the screens their whole job happens on. */
    expect(forFinance.map((i) => i.href)).toEqual(expect.arrayContaining(["/quotes", "/purchase-orders"]));
    for (const item of forFinance) expect(item.children ?? []).toHaveLength(0);

    const forIt = visibleNav({ crm: false, money: false, mail: false, ops: true }).flatMap(
      (s) => s.items
    );
    expect(forIt.map((i) => i.href)).not.toContain("/quotes");
    for (const item of forIt) expect(item.children ?? []).toHaveLength(0);
  });
});

describe("the disclosure", () => {
  it("is a button, not a second link — it opens, it does not navigate", () => {
    expect(sidebar).toMatch(/hasChildren && \(\s*<button/);
    expect(sidebar).toMatch(/aria-expanded=\{expanded\}/);
    /* It toggles state and nothing else. A router push here would be the bug
       this control was added to remove. */
    expect(sidebar).toMatch(/onClick=\{\(\) => setToggled/);
  });

  it("is named for what it will do, since it is a bare chevron", () => {
    expect(sidebar).toMatch(/aria-label=\{`\$\{expanded \? "Hide" : "Show"\} pages under/);
  });

  it("is not drawn on a collapsed sidebar, where there is no room for children", () => {
    expect(sidebar).toMatch(/const hasChildren = Boolean\(item\.children\?\.length\) && !collapsed;/);
  });
});

describe("where the reader is", () => {
  it("still opens the group by default", () => {
    /* Arriving on /quotes must not leave the sidebar looking like nothing is
       selected. The hand-made choice is an override of this, not a replacement
       for it. */
    expect(sidebar).toMatch(/const expanded = toggled\[item\.href\] \?\? childrenOpen;/);
    expect(sidebar).toMatch(/active \|\| \(item\.children\?\.some/);
  });

  it("keeps a hand-made choice to the row it was made on", () => {
    /* Keyed by href. One object for the whole sidebar with a single boolean in
       it would mean opening Projects also opened everything else. */
    expect(sidebar).toMatch(/setToggled\(\(t\) => \(\{ \.\.\.t, \[item\.href\]: !expanded \}\)\)/);
  });
});
