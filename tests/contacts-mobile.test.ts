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

  it("shows the real location column, not the company name again", () => {
    /**
     * This row read `companyInfo`, and `companyInfo` and `company` both derive
     * from the same `info` column — so the panel printed the company name twice
     * and labelled the second one "Company Info". Relabelling it "Location"
     * made that actively wrong: "Location: Dube Landscaping".
     *
     * There was nothing to clean up. `contacts.location` exists, is populated
     * for all 15 records, and holds Cape Town / Johannesburg / Durban /
     * Pretoria. Nothing was reading it.
     */
    expect(view).toMatch(/label="Location" value=\{contact\.location\}/);
    const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toMatch(/Company Info/);
    /* And the company name is not printed twice. */
    expect(code).not.toMatch(/value=\{contact\.companyInfo\}/);
  });

  it("gives the edit form a location field, which stops it wiping them", () => {
    /**
     * `parseContact` has always read `formData.get("location")`, and the form
     * never had that input — so every save sent `text(null)`, which is `""`,
     * which is not `undefined`, so the repo's
     * `location = CASE WHEN $12 THEN $13 ELSE location END` branch fired and
     * wrote it away.
     *
     * Proven against the dev database inside a rolled-back transaction: a
     * contact holding "Cape Town" came back null after one edit. Fixing a typo
     * in somebody's phone number silently erased where they were.
     */
    expect(view).toMatch(/name="location" label="Location"[\s\S]{0,80}?defaultValue=\{contact\?\.location\}/);
    const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toMatch(/name="companyInfo"/);
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

/**
 * Contact Activity, rebuilt to read like the Revenue fold on Home.
 *
 * Asked for explicitly, with the instruction not to copy the style verbatim but
 * to make it suit the contacts page. What is borrowed is the STRUCTURE — a
 * titled header with a real scope line under it, a bordered inner surface with
 * column headings, and right-aligned values — because that is what turns a
 * stack of rows into a ledger you can scan.
 */
describe("Contact Activity reads like a ledger", () => {
  it("states when the contact was last touched", () => {
    /**
     * The Revenue fold puts its scope under its title — "$314,400 won · last 6
     * weeks". The equivalent fact on a contact is when anything last happened
     * with them, which is usually why the panel is being read at all.
     *
     * Derived from the entries already loaded, and they arrive newest-first, so
     * it cannot disagree with the rows underneath it.
     */
    expect(view).toMatch(/const latest = entries\[0\]/);
    expect(view).toMatch(/Last activity <TimeAgo at=\{latest\.at\} mode="relative"/);
  });

  it("uses the compact stamp in the summary and the full one in the rows", () => {
    /* The summary wants to read like "last 6 weeks"; the exact instant belongs
       in the ledger row, where it is the record rather than a headline. */
    const panel = view.slice(view.indexOf("function ActivityPanel"));
    expect(panel).toMatch(/mode="relative"/);
    expect(panel).toMatch(/<TimeAgo at=\{e\.at\} className="shrink-0 pt-0\.5/);
  });

  it("gives the list an axis to read along", () => {
    /* Column headings and a bordered surface — the two things that make the
       Revenue table scannable, and the two the old loose list lacked. */
    expect(view).toMatch(/overflow-hidden rounded-xl border border-\[var\(--border\)\]/);
    expect(view).toMatch(/>Activity<\/span>/);
    expect(view).toMatch(/>When<\/span>/);
    expect(view).toMatch(/divide-y divide-\[var\(--border\)\]/);
  });

  it("shows money as a figure, not a caption", () => {
    /* The one thing worth copying straight from the Revenue table: amounts read
       as numbers you can compare, tabular so the digits line up. */
    expect(view).toMatch(/mt-1 text-sm font-bold tabular-nums/);
  });

  it("keeps the contacts page's own colours rather than Home's green", () => {
    /**
     * Asked for directly. Home's fold is green throughout because it is only
     * about money; this panel carries notes, calls, mail, meetings and deals,
     * so it keeps the per-kind palette and a neutral surface. Green appears
     * only where there is actually money.
     */
    expect(view).toMatch(/note: \{ icon: StickyNote, color: "var\(--purple\)"/);
    expect(view).toMatch(/meeting: \{ icon: Calendar, color: "var\(--amber\)"/);
    const panel = view.slice(view.indexOf("function ActivityPanel"), view.indexOf("/* ---------------- RIGHT"));
    /* No green wash on the surface — the only green is the amount and the
       money chip's own tone. */
    expect(panel).not.toMatch(/green-soft/);
  });

  it("still says nothing rather than inventing rows when empty", () => {
    /* The panel this replaces shipped three fabricated entries. */
    expect(view).toMatch(/Nothing logged yet\. Calls, texts, emails, notes, meetings and won deals/);
  });
});
