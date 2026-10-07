/*
   The sticky page header, and the backing that has to hide what goes under it.

   Reported with a screenshot: scrolling the inbox made the header and the page
   illegible at once — the message list and the message body showing through the
   category chips and the folder tabs, with the header's own labels interleaved
   through both ("Drafts … Received … Trash" reading across a supplier's price
   list). Reproduced at 1066px of content width, scrolled 200px.

   ── Why it looked correct and was not ─────────────────────────────────────

   The header had a backing. It was `color-mix(var(--bg) 62%, transparent)` over
   `backdrop-filter: blur(16px)`, and the blur was supposed to do the hiding
   while the tint only took the edge off, so the aurora behind could still read
   through. Measured in the running app: with the tint removed and the blur left
   on its own, text underneath is perfectly SHARP. `backdrop-filter` is a no-op
   there — `main` is both the scroll container and an `@container`. So the only
   thing ever doing any work was a 62% tint, which dims text without hiding it.

   That is the shape worth guarding. The CSS read as a frost, reviewed as a
   frost, and rendered as a tint, so nothing short of looking at the pixels
   would have caught it — and nothing in the file admitted the dependency.

   These are source assertions, which cannot see pixels either. What they CAN do
   is hold the two properties the fix rests on: the backing does not depend on a
   filter again, and it is driven by whether the page is scrolled rather than by
   a guess about width.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");
const css = read("src/app/globals.css");
const shell = read("src/components/shell/AppShell.tsx");
/*
   Comments stripped before matching.

   Three guards this week have passed or failed against the PROSE EXPLAINING a
   fix rather than the fix — the comment above the inbox header quotes the class
   it replaced, so a plain search finds it and reports the bug as still present.
   A guard that reads commentary is a guard that cannot be trusted either way.
*/
const withoutComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const inbox = withoutComments(read("src/app/(app)/inbox/InboxView.tsx"));

/** Just the `.sticky-head::before` rule, without the essay above it. */
const backing = (() => {
  const start = css.indexOf(".sticky-head::before");
  return css.slice(start, css.indexOf("}", start));
})();

describe("the backing behind a sticky header", () => {
  it("IS OPAQUE, rather than a tint over a filter", () => {
    /* The page colour, flat. A translucent backing only dims what passes
       underneath, and dimmed text over a header's own labels is two unreadable
       things rather than one. */
    expect(backing).toMatch(/background:\s*var\(--bg\);/);
    expect(backing, "the backing is translucent again").not.toMatch(/color-mix/);
  });

  it("DOES NOT DEPEND ON backdrop-filter, which does nothing here", () => {
    /*
       The whole defect in one line. Re-adding this would restore a backing that
       reads as a frost in the source and renders as a tint on the screen —
       `main` is the scroll container and an `@container`, and the pseudo-element
       never samples it.
    */
    expect(backing, "backdrop-filter is back on the sticky header").not.toMatch(
      /backdrop-filter/
    );
  });

  it("is invisible at rest and solid once the page has scrolled", () => {
    /* Both complaints at once. Opaque at rest is the slab across the aurora
       that the frost was introduced to remove; transparent while scrolled is
       what made the header unreadable. Only the scroll position tells them
       apart. */
    expect(backing).toMatch(/opacity:\s*0;/);
    expect(css).toMatch(/main\[data-scrolled="true"\]\s*\.sticky-head::before\s*\{\s*opacity:\s*1;/);
  });
});

describe("what decides that it is scrolled", () => {
  it("is the scroller's own position, written onto the scroller", () => {
    expect(shell).toMatch(/el\.dataset\.scrolled = el\.scrollTop > 2 \? "true" : "false";/);
    expect(shell).toMatch(/el\.addEventListener\("scroll", sync, \{ passive: true \}\)/);
  });

  it("also re-checks when the page RESIZES, which fires no scroll event", () => {
    /* A pane opening, a list arriving, a window resize: the page can become
       scrollable, or stop being, with nobody touching the wheel. */
    expect(shell).toMatch(/new ResizeObserver\(sync\)/);
  });

  it("does not re-render the shell on every scroll frame", () => {
    /* The attribute is the entire output and CSS is the only reader, so this
       stays out of React state — re-rendering the whole application shell on
       each scroll frame would be a cost with nothing to show for it. */
    const effect = shell.slice(shell.indexOf("const mainRef"), shell.indexOf("}, []);"));
    expect(effect, "scroll state moved into React state").not.toMatch(/setS[a-zA-Z]*\(/);
  });

  it("IS NOT GUESSED FROM WIDTH", () => {
    /*
       What was there before: `@min-[1100px]:before:hidden` on the inbox header,
       standing for "the panes scroll internally at this size, so nothing ever
       passes underneath". True at most sizes. Where it was false the header did
       not merely look over-decorated — it became unreadable, which is the worse
       failure and the silent one.
    */
    expect(inbox, "the width proxy for 'nothing scrolls' is back").not.toMatch(
      /before:hidden/
    );
  });
});
