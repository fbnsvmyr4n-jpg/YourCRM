import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The inbox on a phone.
 *
 * Reported as cluttered — "too many headings for the user to get work done,
 * they'd spend more time looking at the headings than the messages" — and on
 * the screen this is where a salesperson spends most of their day.
 *
 * Measured at 393x850 before any change: 234px of controls above the first
 * message, on a content area of 770. Two ways of slicing the inbox were stacked
 * on top of each other — five category tiles above six folder tabs — so the
 * reader passed eleven filter controls, a search field and a sort before
 * reaching anything anyone had sent them. On a quiet account all five category
 * counts read 0.
 *
 *   chrome above the first message   234px -> 96px
 */

const view = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/inbox/InboxView.tsx", import.meta.url)),
  "utf8"
);
const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("one way of slicing the inbox, not two", () => {
  it("takes the category tiles off the phone", () => {
    /* They are a facet, not a place you live. 134px of the 234, and five zeros
       on a quiet account. */
    expect(view).toMatch(/className="tab-row hidden flex-wrap items-center gap-2\.5 @min-\[720px\]:flex"/);
  });

  it("puts them behind the filter control the list already had room for", () => {
    /**
     * Search, sort, filter, then the accent primary action — the same toolbar
     * the contacts list uses, so the two lists in this app are operated the
     * same way. Nothing is lost: the categories keep their counts and their
     * colours inside the menu.
     */
    expect(view).toMatch(/title="Filter by type"/);
    expect(view).toMatch(/aria-label="Create new email"/);
    expect(view).toMatch(/setCategory\(category === c \? null : c\)/);
    /* And both are phone-only — the desktop header still carries them. */
    expect(view).toMatch(/className="@min-\[720px\]:hidden"/);
    expect(view).toMatch(/rounded-full @min-\[720px\]:hidden"/);
  });

  it("opens the filter menu outside the card that would slice it", () => {
    /**
     * It used to be `absolute` inside a wrapper marked `relative`, and the
     * wrapper sits in the list `.card` — which sets `overflow: hidden` to keep
     * rows inside its rounded corners. Measured at 393x850 with the list empty:
     * the card was 128px tall and the menu 230, so "All types" and half of
     * "Appointments" were visible and the other five rows did not exist.
     *
     * The taller the list, the less often anyone notices, which is why it
     * survived on the pages with real data in them.
     */
    expect(code).toMatch(/<AnchoredMenu anchor=\{filterAnchor\}/);
    /* The `relative` wrapper went with it. Left behind it would do nothing and
       still read as though the menu were positioned against it. */
    expect(code).not.toMatch(/relative @min-\[720px\]:hidden/);
    expect(code).not.toMatch(/absolute right-0 top-full/);
  });

  it("does not ask for a placeholder the field is too narrow to show", () => {
    /**
     * Two controls were added to this toolbar, and on his iPhone the search
     * field measured 145px — "Search messages" rendered as "Search me". A
     * truncated placeholder reads as a broken field rather than a short one.
     *
     * Measured on the toolbar rather than the window: the field's width is what
     * the toolbar leaves it, and the sidebar makes those two different.
     */
    expect(code).toMatch(/narrowToolbar \? "Search" : "Search messages"/);
    expect(code).toMatch(/useElementWidth\(toolbarRef\) < 720/);
  });

  it("still says what a category would return before you pick it", () => {
    /* A row that silently produces an empty list is worse than one that says
       there is nothing in it. */
    expect(view).toMatch(/disabled=\{n === 0 && category !== c\}/);
  });
});

describe("the reader is its own screen on a phone", () => {
  it("opens a message instead of stacking it under the list", () => {
    /**
     * Below `@min-[720px]` the panels stack, so a selected message rendered
     * beneath the entire list — to read it you scrolled past every other
     * message first. The list IS the page at that width, and opening a message
     * should open it.
     *
     * The same pattern the contacts page already uses, down to the way back.
     */
    expect(view).toMatch(/const stacked = gridWidth < 720/);
    expect(view).toMatch(/const listOnly = stacked && !showReader/);
    expect(view).toMatch(/const readerOnly = stacked && showReader/);
    expect(view).toMatch(/All messages/);
  });

  it("derives the hiding rather than syncing it in an effect", () => {
    /* Every decision is gated on `stacked`, so on a wide layout both are false
       whatever `showReader` holds. There is no state to correct, only state to
       ignore — and no effect for the React compiler to reject. */
    expect(code).not.toMatch(/useEffect\([^)]*setShowReader/);
  });

  it("drops the empty panes that were only holding columns open", () => {
    /**
     * "No message selected." sat under the list on a phone: an answer to a
     * question nobody had asked, in the room the messages should have had. It
     * is a desktop grid cell, so it now only exists where there is a column for
     * it to fill.
     */
    expect(view).toMatch(/card hidden min-h-0 place-items-center p-6 text-sm text-faint @min-\[720px\]:grid/);
    expect(view).toMatch(/card hidden @min-\[720px\]:block @min-\[720px\]:\[grid-area:card\]/);
  });

  it("hides the folder tabs while a message is open", () => {
    /* Folders are how you choose what to read; once you are reading they are
       72px of navigation to somewhere you have already been. */
    expect(view).toMatch(/sticky-head[\s\S]{0,120}?readerOnly && "hidden"/);
  });
});

describe("the width is measured once, by the shared hook", () => {
  const hook = readFileSync(
    fileURLToPath(new URL("../src/lib/use-element-width.ts", import.meta.url)),
    "utf8"
  );

  it("watches the grid rather than the viewport", () => {
    /**
     * The breakpoints here are container queries and the container is the
     * viewport minus the sidebar, so a viewport media query would disagree with
     * the layout across the whole range where the sidebar is present but the
     * content is still narrow.
     *
     * Lifted out of ContactsView when this page needed the same thing — a
     * second ResizeObserver is how two pages start disagreeing about what
     * "narrow" means.
     */
    expect(hook).toMatch(/ResizeObserver/);
    expect(view).toMatch(/useElementWidth\(gridRef\)/);
    expect(code).not.toMatch(/matchMedia/);
  });
});
