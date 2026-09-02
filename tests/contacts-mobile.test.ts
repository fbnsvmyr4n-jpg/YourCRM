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
const widthHook = readFileSync(
  fileURLToPath(new URL("../src/lib/use-element-width.ts", import.meta.url)),
  "utf8"
);
const hook = readFileSync(
  fileURLToPath(new URL("../src/lib/remembered-toggle.ts", import.meta.url)),
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
    /* The observer moved into `useElementWidth` when the inbox needed the same
       thing — a second copy is how two pages start disagreeing about what
       "narrow" means. The thresholds stay at the call site, because two
       decisions key off this one measurement: stacking at 700 and the activity
       fold at 1030. */
    expect(widthHook).toMatch(/ResizeObserver/);
    expect(widthHook).toMatch(/setWidth\(entry\.contentRect\.width\)/);
    expect(view).toMatch(/const gridWidth = useElementWidth\(gridRef\)/);
    expect(view).toMatch(/const stacked = gridWidth < 700/);
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
     *
     * It used to take `entries[0]` outright, which is the same rule stated
     * carelessly: the timeline holds SCHEDULED meetings too, so a booking for
     * Friday made the line read "Last activity in 2 days". The guarantee this
     * test exists for is unchanged — the line names when the contact was last
     * touched — but it now names the newest entry that has actually happened.
     */
    expect(view).toMatch(/Last activity\{" "\}/);
    expect(view).toMatch(/<TimeAgo at=\{lastPast\.at\} mode="relative"/);
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

/**
 * Contact Activity folds, the way the dashboard's sections do.
 *
 * Asked for because a contact with any history put its whole timeline between
 * the reader and the Status panel underneath it — reaching Status meant
 * scrolling past everything that had ever happened.
 *
 * Measured at a grid width of 1010: the panel is 264px open and 96px closed.
 * The saving grows with the history; 264 is a contact with a single entry.
 */
describe("the activity fold", () => {
  it("remembers, and shares that memory with the dashboard's folds", () => {
    /**
     * Extracted rather than copied. The markup around a fold is site-specific —
     * the dashboard collapses at `sm`, this collapses where Status stops having
     * its own column — but the remembering is the subtle part and there should
     * be one of it.
     */
    expect(view).toMatch(/useRememberedToggle\("contact-open:activity", false\)/);
    expect(hook).toMatch(/useSyncExternalStore/);
    /* Its own namespace, so opening the history on a contact does not decide
       anything about the dashboard. */
    expect(view).not.toMatch(/dash-open:/);
  });

  it("starts closed", () => {
    /* The summary line above already answers the common question — when this
       person was last touched — so the detail is opt-in. */
    expect(view).toMatch(/useRememberedToggle\("contact-open:activity", false\)/);
  });

  it("only exists where Status is not already beside it", () => {
    /**
     * Below the three-column width Status sits underneath this panel, so the
     * fold saves a scroll. At 1030 and above they are side by side and it would
     * be a control that tidies away something already in view.
     *
     * The threshold comes from the same observer the layout uses, so the fold
     * and the columns cannot disagree about which arrangement is on screen.
     */
    expect(view).toMatch(/const foldsActivity = gridWidth < 1030/);
    expect(view).toMatch(/const stacked = gridWidth < 700/);
  });

  it("tells the truth about its own state", () => {
    /**
     * Driven from CSS alone this announced `aria-expanded="false"` on a desktop
     * where the content was plainly visible — telling a screen reader the
     * section was collapsed while sighted users read the list. Measured at grid
     * 1236 after the fix: no `aria-expanded` at all, the control disabled, no
     * chevron, and the body shown even with a stored "closed" preference.
     */
    expect(view).toMatch(/aria-expanded=\{foldsActivity \? open : undefined\}/);
    expect(view).toMatch(/disabled=\{!foldsActivity\}/);
    /* The chevron is rendered only where pressing it does something. */
    expect(view).toMatch(/\{foldsActivity && \(\s*<ChevronDown/);
    /* And the body ignores the remembered state where the fold does not exist. */
    expect(view).toMatch(/className=\{clsx\(foldsActivity && !open && "hidden"\)\}/);
  });

  it("makes the whole header the target", () => {
    /* A small chevron is a small target on a phone, which is the device this is
       for. The dashboard's folds take the same approach. */
    expect(view).toMatch(/onClick=\{toggle\}/);
    expect(view).toMatch(/aria-controls="contact-activity"/);
    expect(view).toMatch(/id="contact-activity"/);
  });
});

describe("a way out at the end of the list", () => {
  it("offers to close from the bottom", () => {
    /**
     * Reported as extra work, and it is: opening the fold puts the control that
     * closes it at the top of everything it just revealed, so on a long history
     * you scroll back past the whole thing to put it away.
     *
     * Measured at grid 1010 with one entry: the header sits at y=747 and the
     * bottom control at y=931. On a real history that gap is the whole list.
     */
    expect(view).toMatch(/Hide activity/);
    expect(view).toMatch(/<ChevronUp className="h-3\.5 w-3\.5" \/>/);
  });

  it("only appears where it is the shorter way out", () => {
    /**
     * Where the fold does not exist there is nothing to close; while it is
     * closed there is nothing to close either; and under the empty state the
     * header is already in view, so a second control would be noise rather
     * than a shortcut.
     */
    expect(view).toMatch(/\{foldsActivity && open && entries\.length > 0 && \(/);
  });

  it("hands focus back to the header", () => {
    /**
     * The button that did it is the first thing to disappear, and a control
     * that vanishes drops keyboard focus to the body — the reader loses their
     * place in the page entirely. The header is both where they now are on
     * screen and the control that would open it again.
     *
     * Verified live: after pressing it, the body is hidden, the button is gone,
     * and `document.activeElement` is the header.
     */
    expect(view).toMatch(/const collapse = useCallback\(\(\) => \{\s*toggle\(\);\s*headerRef\.current\?\.focus\(\);/);
    expect(view).toMatch(/onClick=\{collapse\}/);
    expect(view).toMatch(/ref=\{headerRef\}/);
  });
});

describe("the pool survives a dropped connection", () => {
  const db = readFileSync(
    fileURLToPath(new URL("../src/server/db.ts", import.meta.url)),
    "utf8"
  );

  it("listens for idle client errors", () => {
    /**
     * Found in the browser console while testing: "Connection terminated
     * unexpectedly", beside ECONNRESET.
     *
     * `pg` emits `error` on the Pool when a client sitting idle in it fails,
     * and hosted Postgres drops idle connections as a matter of course — Neon
     * closes them after a few minutes. An EventEmitter `error` with no listener
     * does not warn, it THROWS: an uncaught exception that kills a serverless
     * instance mid-request, for a reason unrelated to whoever was asking.
     *
     * Attaching a listener is the whole fix; `pg` has already discarded the
     * broken client, and the next query opens a fresh one.
     */
    expect(db).toMatch(/pool\.on\("error"/);
  });

  it("does not log the connection string", () => {
    /* It carries the password. Only the message goes to the log. */
    const handler = db.slice(db.indexOf('pool.on("error"'), db.indexOf('pool.on("error"') + 260);
    expect(handler).toMatch(/err\.message/);
    expect(handler).not.toMatch(/connectionString|DATABASE_URL/);
  });
});

describe("the contacts list header", () => {
  it("gives the heading its own line", () => {
    /**
     * Five 36px controls plus their gaps need 212px, and this column is a fixed
     * 326 on a desktop and narrower on a phone — so "Contacts 15" truncated to
     * "Conta…" at every width, not only the small ones. No single row fits
     * both, and a heading that cannot be read is a worse trade than one more
     * line.
     */
    expect(view).toMatch(/<h2 className="text-lg font-semibold tracking-tight">Contacts<\/h2>/);
    const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toMatch(/<h2 className="min-w-0 truncate/);
  });

  it("puts something at each end of the title line", () => {
    /* Title left, count right — the arrangement the Contact Activity panel
       already uses, so the two titled blocks on this page read as one family,
       and the right half of the line is not left empty. */
    expect(view).toMatch(/<div className="flex items-baseline justify-between gap-3">/);
    expect(view).toMatch(/<span className="text-sm text-faint tabular-nums">\{visible\.length\}<\/span>/);
  });

  it("wears the accent rule the app puts under a section title", () => {
    /* Its absence is part of why this read as a loose label rather than the
       head of a panel. The Contact Activity heading on the same page has one. */
    /* Scoped to this header. The identical rule exists in the Contact Activity
       panel — which is the point, they should match — so an unscoped assertion
       passed with this one deleted. Caught by mutation. */
    const header = view.slice(view.indexOf('>Contacts</h2>'), view.indexOf("Was a decorative chevron"));
    expect(header).toMatch(/<span className="mt-2 block h-0\.5 w-10 rounded-full accent-gradient" \/>/);
  });

  it("spreads the controls instead of huddling them at one end", () => {
    /**
     * Right-aligning them left the whole left half of the row empty, so a
     * balanced heading sat above an unbalanced strip — which is what read as
     * unfinished.
     *
     * Measured after: at a 326px desktop column the four gaps are 26px each and
     * at 430px they are 42px each — equal in both, with the first button's left
     * edge on the heading's and the last button's right edge on the count's.
     */
    expect(view).toMatch(/<div className="relative mt-3 flex items-center justify-between gap-2">/);
  });
});

describe("the activity summary tells the truth about time", () => {
  /**
   * The line under "Contact Activity" read **"Last activity in 2 days"**.
   *
   * The timeline carries scheduled meetings alongside history and is sorted
   * newest first, so `entries[0]` was a meeting booked for Friday — a thing
   * that had not happened, announced as the last thing that had. The contact's
   * real last contact had been two hours earlier, and it said so in the row
   * directly beneath.
   *
   * A summary contradicting its own rows is the worst kind of wrong here: it is
   * the one part of the panel a reader trusts without scrolling.
   */
  it("separates what happened from what is booked", () => {
    expect(view).toMatch(/const \{ lastPast, nextUp \} = splitTimeline\(entries, now \?\? 0\);/);
    /* The old single pick, which is the bug itself. */
    expect(view).not.toMatch(/const latest = entries\[0\];/);
  });

  it("says both, because they are one situation", () => {
    /* "You spoke two hours ago, you are due to meet on Friday" is what the
       panel exists to answer — filtering the future out would have fixed the
       lie by deleting half the answer. */
    expect(view).toMatch(/Last activity\{" "\}/);
    expect(view).toMatch(/\{" · next "\}/);
    expect(view).toMatch(/\{nextUp && \(/);
    /* And it still admits when nothing has happened yet. */
    expect(view).toMatch(/"Nothing logged yet"/);
  });

  it("waits for the clock rather than guessing which side of now things fall", () => {
    /**
     * `Date.now()` read during render is impure, and answers differently on the
     * server than in the browser — the summary would claim a meeting was past
     * during SSR and future a moment later. The shared clock every timestamp on
     * the page already uses is null until hydration, so the line holds its
     * height and says nothing until it can say something true.
     */
    expect(view).toMatch(/const now = useNow\(\);/);
    expect(view).toMatch(/now !== null \?/);
    expect(view).toMatch(/style=\{\{ visibility: "hidden" \}\} aria-hidden/);
    /* Nothing may read the wall clock directly in here. */
    expect(view).not.toMatch(/Date\.now\(\)/);
  });
});
