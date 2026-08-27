import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every modal must be able to show all of itself on a phone.
 *
 * Reported on the deal panel: "Record a payment" sits below a pain-points block
 * and a partly-paid banner, and on an iPhone the amount field and its button
 * were simply off the bottom of the screen with no way to reach them.
 *
 * Measured on the real compiled stylesheet at 375x812, using the deal panel's
 * own wrapper and a panel taller than the viewport:
 *
 *   before  panel 1698px, submit button at y=1689 — 877px below the fold
 *   after   panel  780px, scrolls, button reaches y=771 — on screen
 *
 * The cause was structural rather than local. Every wrapper centres its panel,
 * so a panel with no height limit overflows at BOTH ends and nothing scrolls.
 * Seven of the eleven panels had no limit at all; the four that did used `vh`,
 * which on iOS is the viewport with the browser toolbar HIDDEN — so even those
 * ran underneath Safari's toolbar.
 */

const css = readFileSync(
  fileURLToPath(new URL("../src/app/globals.css", import.meta.url)),
  "utf8"
);

/** Every source file that renders something, so a sweep cannot miss one. */
function sourceFiles(dir: URL): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) out.push(...sourceFiles(child));
    else if (entry.name.endsWith(".tsx")) out.push(fileURLToPath(child));
  }
  return out;
}

const files = sourceFiles(new URL("../src/", import.meta.url));

describe("modal panels on a phone", () => {
  it("caps and scrolls every panel from one place", () => {
    /* On the class itself, so the next modal written cannot be written without
       it. `.modal-surface` is unlayered CSS and Tailwind's utilities are
       layered, so this also wins over any per-panel utility. */
    const rule = css.slice(css.indexOf(".modal-surface {"));
    expect(rule).toMatch(/max-height:\s*calc\(100dvh - 2rem\)/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  it("measures the viewport as it actually is, not as it could be", () => {
    /**
     * `dvh`, never `vh`. On iOS `vh` is the LARGE viewport — the height with
     * the toolbar hidden — so a panel at `90vh` still runs under Safari's
     * toolbar whenever the toolbar is showing, which is most of the time.
     */
    const rule = css.slice(css.indexOf(".modal-surface {"), css.indexOf(".modal-surface {") + 1200);
    expect(rule).not.toMatch(/max-height:\s*calc\(100vh/);
  });

  it("stops the page behind scrolling when the panel runs out", () => {
    /* Without this, reaching the end of a dialog starts dragging the board it
       is covering — on iOS that is how a modal ends up scrolling the page
       underneath it. */
    const rule = css.slice(css.indexOf(".modal-surface {"));
    expect(rule).toMatch(/overscroll-behavior:\s*contain/);
  });

  it("leaves no panel with a competing cap of its own", () => {
    /**
     * An inline `style={{ maxHeight: "90vh" }}` beats the stylesheet outright,
     * so one contact form would have kept the wrong unit while every other
     * modal was fixed. Utilities are only shadowed rather than beaten, which is
     * worse: the class stays in the markup claiming something that no longer
     * happens.
     */
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const line of src.split("\n")) {
        if (!line.includes("modal-surface")) continue;
        expect(line, `${file} caps modal-surface itself`).not.toMatch(/max-h-\[/);
        expect(line, `${file} caps modal-surface itself`).not.toMatch(/overflow-y-auto/);
      }
      expect(src, `${file} sets maxHeight inline`).not.toMatch(/style=\{\{ maxHeight: "\d+vh" \}\}/);
    }
  });

  it("never sizes a mobile box to a height the phone does not have", () => {
    /**
     * `h-[calc(100vh-…)]` with no breakpoint prefix applies on a phone, where
     * it is taller than the screen showing it — the contacts empty state
     * centred its message against a height the reader could not see.
     *
     * Prefixed uses (`sm:`, `lg:`, `@min-[…]`) are desktop-only and correct
     * there, because `vh` and `dvh` are the same when nothing collapses.
     */
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const line of src.split("\n")) {
        const m = line.match(/(^|[\s"'`])((?:min-|max-)?h-\[calc\(100vh)/);
        if (!m) continue;
        const before = line.slice(0, m.index ?? 0);
        const prefixed = /(sm|md|lg|xl|@min-\[[^\]]+\]):$/.test(before.trimEnd());
        expect(prefixed, `${file}: unprefixed 100vh height — ${line.trim().slice(0, 80)}`).toBe(true);
      }
    }
  });
});
