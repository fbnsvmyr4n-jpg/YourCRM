import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * On a phone, the list of contacts IS the page.
 *
 * The three panels collapse into one column below 700px, in DOM order: details,
 * profile, then the list. Measured on a 852px screen with six contacts, that
 * put the list — the whole point of the page — at y=1648. The user landed on
 * the details of somebody they had not chosen and had to scroll past two full
 * screens to reach the index.
 *
 * So a stacked layout behaves like every contacts app on a phone: the list is
 * the page, and choosing somebody opens them. Nothing about the side-by-side
 * layout changes, because there the list is already in view.
 */

const view = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/contacts/ContactsView.tsx", import.meta.url)),
  "utf8"
);

describe("the contacts list on a stacked layout", () => {
  it("measures the grid's own width, not the viewport's", () => {
    /**
     * The layout keys off container queries (`@min-[700px]`), and the container
     * is the viewport minus the sidebar. A viewport media query would disagree
     * with the layout across the whole range where the sidebar is present but
     * the content is still narrow — claiming two columns while the user looks
     * at one.
     */
    expect(view).toMatch(/ResizeObserver/);
    expect(view).toMatch(/contentRect\.width < 700/);
    expect(view).not.toMatch(/matchMedia\(["'`]\(max-width/);
  });

  it("hides the detail panels until a contact is chosen", () => {
    expect(view).toMatch(/const listOnly = stacked && !showDetail/);
    expect(view).toMatch(/listOnly && "hidden"/);
  });

  it("hides the list once one is open, and offers a way back", () => {
    expect(view).toMatch(/const detailOnly = stacked && showDetail/);
    expect(view).toMatch(/detailOnly && "hidden"/);
    expect(view).toMatch(/All contacts/);
  });

  it("opens the contact that was tapped", () => {
    /* `onSelect` used to be `setSelectedId`, which changed which contact the
       detail panels described without revealing them — invisible on a phone,
       because those panels were two screens further down. */
    expect(view).toMatch(/onSelect=\{openContact\}/);
    expect(view).toMatch(/setShowDetail\(true\)/);
  });

  it("derives the hiding rather than syncing it in an effect", () => {
    /**
     * The first version reset `showDetail` in an effect when the layout
     * widened, which React's own lint rule flags as cascading renders — and it
     * was unnecessary. Every hiding decision is gated on `stacked`, so on a
     * wide layout both flags are false and nothing is hidden whatever
     * `showDetail` holds. There is no state to correct, only state to ignore.
     */
    expect(view).not.toMatch(/useEffect\(\(\) => \{\s*if \(!stacked\) setShowDetail/);
  });
});

/**
 * The contact detail, reworked from a page-by-page review of the real screen.
 *
 * Everything here is about the stacked layout, where the three panels become
 * one column. The two- and three-column layouts place these with named grid
 * areas and are deliberately untouched — verified at 1440: three columns of
 * 290/461/326, every `order` back to 0, actions in a single row of six.
 */
describe("the person comes before the paperwork", () => {
  it("puts the card first and the fields second when stacked", () => {
    /**
     * Stacked, the DOM order was fields-then-card, so opening somebody put a
     * Status heading and a column of labelled rows above the thing that says
     * who they are — the avatar, the name, and every action you might take.
     * You had to scroll past the record to reach the person.
     *
     * `order` rather than moved markup: from `@min-[700px]` up the named grid
     * areas already place these correctly and are written against the source
     * order, so both are reset there.
     */
    expect(view).toMatch(/"order-2 @min-\[700px\]:order-none @min-\[700px\]:\[grid-area:info\]"/);
    expect(view).toMatch(/"order-1 @min-\[700px\]:order-none @min-\[700px\]:\[grid-area:profile\]"/);
  });
});

describe("the action row", () => {
  it("wraps to three across before the labels collide", () => {
    /**
     * Six columns needed 66px a cell at the 440px cap and got 48 on a phone —
     * exactly the width of the circle, leaving nothing for the label under it,
     * so "Revenue" and "Email" ran into their neighbours. Measured at 390px
     * after: six buttons, two rows of three, 95px each, ZERO overlapping pairs.
     *
     * Six returns at `@min-[1030px]`, which is where the surrounding grid
     * guarantees the middle column 380px — the floor its own comment names.
     */
    expect(view).toMatch(/grid-cols-3 gap-x-2 gap-y-4 @min-\[1030px\]:grid-cols-6 @min-\[1030px\]:gap-y-2/);
  });
});

describe("the fields say what they are", () => {
  it("leads with the whole name, then its parts", () => {
    /* It is what you came to check; first and last are the detail under it. */
    const panel = view.slice(view.indexOf('<Section title="Personal Information">'));
    const whole = panel.indexOf('contact.type === "lead" ? "Lead Name"');
    const first = panel.indexOf('label="First Name"');
    const last = panel.indexOf('label="Last Name"');
    expect(whole).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(whole);
    expect(last).toBeGreaterThan(first);
  });

  it("asks for a Location rather than 'Company Info'", () => {
    /**
     * "Company Info" asked for anything and so collected nothing useful — the
     * demo record has it repeating the company name back. "Location" asks a
     * question with one answer.
     *
     * The stored field is still `companyInfo`, so nothing already typed is
     * lost: it is the prompt that changed, not the column.
     */
    expect(view).toMatch(/label="Location" value=\{contact\.companyInfo\}/);
    expect(view).toMatch(/name="companyInfo" label="Location"/);
    const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toMatch(/Company Info/);
  });

  it("does not show revenue twice", () => {
    /**
     * The Won/Open pair sat in this panel and was the same two figures the
     * Revenue panel opens with — one tap away on the card, with the deals that
     * make them up underneath. Two places showing one number is how they drift,
     * and this panel is the record, not the reporting.
     */
    const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toMatch(/MiniStat/);
    /* The Revenue panel keeps them, which is the point of removing the copy. */
    expect(view).toMatch(/function RevenuePanel/);
  });
});
