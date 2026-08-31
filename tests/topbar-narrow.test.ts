import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The header must survive a narrow phone.
 *
 * Every screen in the app shares this row, so when it overflowed, every screen
 * showed a cut-off search bar — which is exactly what a page of phone
 * screenshots came back looking like.
 *
 * Measured at 320px before the fix: the search button rendered 292px wide and
 * the avatar's right edge landed at 540, which is 220px past the viewport. The
 * shell clips rather than scrolls, so there was not even a scrollbar to reach
 * the controls that had been pushed off.
 */

const source = readFileSync(
  fileURLToPath(new URL("../src/components/shell/Topbar.tsx", import.meta.url)),
  "utf8"
);

/**
 * The search button's className VALUE, not the surrounding block.
 *
 * The first version of this file sliced from `aria-label="Search"` to the next
 * `</button>` and matched against that — which silently included the comment
 * explaining why `min-w-0` matters. That comment names the class in prose, so
 * the assertion passed against the documentation rather than the code, and
 * deleting `min-w-0` from the actual className did not fail anything. Caught by
 * mutation, which is the only reason it was caught at all.
 *
 * Reading the attribute itself is the fix: prose cannot satisfy it.
 */
const searchClassName = (() => {
  const at = source.indexOf('aria-label="Search"');
  const rest = source.slice(at);
  const match = rest.match(/className="([^"]*)"/);
  if (!match) throw new Error("could not find the search button's className");
  return match[1];
})();

describe("the top bar on a narrow screen", () => {
  it("lets the search field shrink", () => {
    /**
     * The whole bug in one property. `flex-1` is `flex: 1 1 0%`, but a flex
     * item's AUTOMATIC MINIMUM SIZE is `min-width: auto`, resolving to its
     * min-content width — and this button carries 60px of padding. Its minimum
     * was therefore never small enough to fit, so instead of shrinking it shoved
     * everything after it off the screen.
     *
     * It is also the easiest thing in the world to delete by accident, because
     * on a desktop it appears to do nothing at all.
     */
    expect(searchClassName.split(/\s+/)).toContain("min-w-0");
    /* `flex-1` is now conditional: below 390 this is a fixed-width icon button,
       not a field, so there is nothing to flex. From 390 up — every width this
       assertion was originally written about — it is `flex-1` again, and the
       automatic-minimum-size trap above still applies exactly as it did. */
    expect(searchClassName.split(/\s+/)).toContain("min-[390px]:flex-1");
  });

  it("shortens the placeholder rather than truncating it", () => {
    /* There is no width at which the full placeholder fits on a 320px phone
       beside four other controls; it can only render as "Search cont…".

       The threshold moved from 420 to 740, because 420 was never where it fit.
       Measured against the compiled stylesheet, the long form needs 237px of
       text box and had 88 at 420, 161 at 660 and 201 at 700 — so from 420 to
       past the desktop breakpoint it rendered as "Search contacts, compa…",
       the exact truncation this pair of spans exists to prevent. It first fits
       at 736. */
    expect(source).toMatch(/min-\[740px\]:hidden">Search</);
    expect(source).toMatch(/hidden min-\[740px\]:inline">Search contacts/);
    expect(source).not.toMatch(/min-\[420px\]/);
  });

  it("keeps every desktop value untouched", () => {
    /**
     * The explicit constraint on this change: mobile may improve, desktop may
     * not move. Both gutter overrides are unprefixed (so they apply below `sm`)
     * and the `sm:` values they sit beside are the originals — 28px of padding
     * and a 16px gap, verified in the browser after the change.
     */
    const header = source.slice(source.indexOf("<header"), source.indexOf(">", source.indexOf("<header")));
    expect(header).toMatch(/sm:gap-4/);
    expect(header).toMatch(/sm:px-7/);
  });
});

describe("the assistant shortcut is reachable on a phone", () => {
  /**
   * It was `sm:grid`, so it did not exist below 640px — on every phone the
   * header showed a theme toggle where two buttons were expected, and the
   * assistant had no shortcut at all. On a product whose headline feature is
   * the assistant, hiding it on the device most people carry is the wrong
   * trade.
   */
  const chatLink = (() => {
    const at = source.indexOf('href="/chat"');
    const match = source.slice(at).match(/className="([^"]*)"/);
    if (!match) throw new Error("could not find the assistant shortcut");
    return match[1];
  })();

  it("is not gated behind the desktop breakpoint", () => {
    expect(chatLink).not.toMatch(/\bsm:grid\b/);
  });

  it("is not gated behind ANY width", () => {
    /**
     * `min-[360px]:grid` replaced `sm:grid` and was still a gate. It looked
     * safe — every current iPhone is at least 360pt — but Display Zoom makes a
     * 393pt iPhone report a 320px viewport, so a current handset with an
     * accessibility setting turned on lost the shortcut entirely. That is how
     * this was reported: missing from the header on a real phone.
     *
     * The room now comes from the search instead, which stops being a field
     * below 390. Nothing is traded away: it opens the same command palette
     * with a bigger tap target than the label it gave up.
     */
    expect(chatLink).not.toMatch(/\bhidden\b/);
    expect(chatLink).not.toMatch(/min-\[\d+px\]:grid/);
    expect(chatLink).toMatch(/\bgrid\b/);
  });

  it("keeps its full size when the row is tight", () => {
    /* Unhiding it was not enough. Measured at 320 without `shrink-0`, flex
       squashed it to 26px — present, but a tap target well under the 44px
       minimum and visibly smaller than the bell beside it. */
    expect(chatLink).toMatch(/shrink-0/);
    expect(chatLink).toMatch(/h-10 w-10/);
  });

  it("is an icon button below 390, and a field again above it", () => {
    /**
     * Where the room comes from, and the half that must not leak upward.
     * Measured with all six controls present: the search is 44px at 320 and 88
     * at 360, against 60px of its own padding — which is why the placeholder in
     * the reported screenshot read "Sea…". Below 390 it matches the menu button
     * beside it; at 390 it is a 118px field whose label fits.
     */
    expect(searchClassName).toMatch(/\bh-11 w-11 shrink-0\b/);
    expect(searchClassName).toMatch(/justify-center/);
    for (const restored of [
      "min-\\[390px\\]:h-12",
      "min-\\[390px\\]:w-auto",
      "min-\\[390px\\]:justify-start",
      "min-\\[390px\\]:pl-12",
      "min-\\[390px\\]:pr-3",
    ]) {
      expect(searchClassName).toMatch(new RegExp(restored));
    }
    /* The glyph moves back from centred to the left inset with it. */
    expect(source).toMatch(/-translate-x-1\/2[\s\S]{0,80}?min-\[390px\]:left-4 min-\[390px\]:translate-x-0/);
  });

  it("right-aligns the controls once nothing in the row grows", () => {
    /* Below 390 the search is fixed-width, so without this the cluster packs
       left and leaves a gap after the avatar. Inert from 390 up, where the
       search is `flex-1` again and there is no free space to distribute. */
    expect(source).toMatch(/className="ml-auto flex shrink-0 items-center gap-2 sm:gap-4"/);
  });
});

describe("filter rows wrap tidily on a phone", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../src/app/globals.css", import.meta.url)),
    "utf8"
  );
  const block = css.slice(css.indexOf("@media (max-width: 639.98px)"));

  it("does not hide options behind a horizontal scroll", () => {
    /**
     * The first attempt made these rows scroll sideways, which is the common
     * native idiom and the wrong answer here: it puts filters off the edge of
     * the screen. A filter nobody can see is a filter nobody uses, and nothing
     * on a page this small should need sideways dragging to discover.
     *
     * So the rule must NOT reintroduce a scroll container.
     */
    expect(block).not.toMatch(/\.tab-row\s*\{[^}]*overflow-x:\s*auto/);
    expect(block).not.toMatch(/\.tab-row\s*\{[^}]*flex-wrap:\s*nowrap/);
  });

  it("lets the pills share each row instead of straggling", () => {
    /* `flex: 1 1 auto` stretches every pill to fill the line it lands on, so
       two on a row become two halves rather than two left-aligned pills with a
       gap on the end — which is what read as unfinished. */
    expect(block).toMatch(/\.tab-row > \*\s*\{[^}]*flex:\s*1 1 auto/);
  });

  it("is scoped to below the desktop breakpoint", () => {
    /* `.tab-row` sits on rows that wrap perfectly well on a desktop. If this
       escaped its media query it would restyle every filter row in the app. */
    expect(css).toMatch(/@media \(max-width: 639\.98px\)/);
  });
});

/**
 * Two buttons in one header must not read as the same button.
 *
 * Reported from a phone: the theme control and the assistant shortcut looked
 * identical. In Night the theme icon was `Stars` — a four-pointed sparkle, the
 * same shape as the assistant's `Sparkles` — and on a phone the theme label is
 * hidden, so they were two unlabelled blue sparkles two buttons apart.
 */
describe("the assistant and the theme control are told apart", () => {
  const themeToggle = readFileSync(
    fileURLToPath(new URL("../src/components/theme/ThemeToggle.tsx", import.meta.url)),
    "utf8"
  );
  /* The assistant link's className value, read the same way the block above
     reads it — from the attribute, so prose about it cannot satisfy the
     assertion. */
  const assistantClasses = (() => {
    const at = source.indexOf('href="/chat"');
    const rest = source.slice(at);
    const m = rest.match(/className="([^"]*)"/);
    if (!m) throw new Error("could not find the assistant shortcut");
    return m[1];
  })();

  it("keeps sparkles out of the theme set entirely", () => {
    /* The whole set now reads as one family about the sky — sun, moon,
       sun-and-moon, moon-and-star — and nothing in it looks like AI. */
    const code = themeToggle.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\bStars\b/);
    expect(code).not.toMatch(/\bSparkles\b/);
    expect(code).toMatch(/midnight: MoonStar/);
  });

  it("makes the assistant the one filled control in the row", () => {
    /**
     * Changing the glyph was only half of it. The button sat in a row of
     * identical neutral circles — menu, search, theme, bell — as one more of
     * them, and on a phone none of them carry a label. Being the same SHAPE as
     * its neighbours is what made it confusable, not just the same drawing.
     *
     * It is the shortcut to the product's headline feature, so it is the one
     * control here that should look like a destination rather than a toggle.
     */
    expect(assistantClasses.split(/\s+/)).toContain("btn-accent");
    expect(assistantClasses.split(/\s+/)).not.toContain("btn-soft");
  });

  it("drops the accent tint the filled treatment replaces", () => {
    /* `text-accent` on a filled accent ground is an accent on an accent — it
       reads as a smudge rather than an icon. */
    /* Sliced to the closing tag rather than a guessed number of characters —
       a fixed window is exactly how an earlier assertion in this project ended
       up reading past the line it was checking. */
    const at = source.indexOf('href="/chat"');
    const link = source.slice(at, source.indexOf("</Link>", at));
    expect(link).toMatch(/<Sparkles className="h-\[18px\] w-\[18px\]" \/>/);
  });
});
