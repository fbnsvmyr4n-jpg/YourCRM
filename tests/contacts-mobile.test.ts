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
