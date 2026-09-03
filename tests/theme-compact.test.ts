import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMPACT_QUERY,
  levelForHour,
  levelForViewport,
  MODE_ORDER,
  MODE_ORDER_COMPACT,
  resolveLevel,
  THEME_LABELS,
  type ThemeLevel,
} from "@/lib/theme";

/**
 * A phone has two palettes; a desktop has three.
 *
 * Evening is a gentle step between day and night and earns its place on a big
 * screen. On a phone it is a third near-identical dark, so Day and Night are
 * the whole set there and Auto chooses between them.
 *
 * The important half is that this applies to the RESOLVED level, not just to
 * the picker. Trimming only the picker would have left Auto landing on Evening
 * every day between 18:00 and 21:00 — the palette would still be there, just
 * unreachable on purpose, which is the kind of half-fix that reads as a bug.
 */

describe("what a phone is allowed to paint", () => {
  const LEVELS: ThemeLevel[] = ["light", "dark", "midnight"];

  it("collapses Evening into Night", () => {
    expect(levelForViewport("dark", true)).toBe("midnight");
  });

  it("leaves the other two alone", () => {
    expect(levelForViewport("light", true)).toBe("light");
    expect(levelForViewport("midnight", true)).toBe("midnight");
  });

  it("changes nothing on a desktop", () => {
    for (const l of LEVELS) expect(levelForViewport(l, false)).toBe(l);
  });

  it("never paints Evening on a phone, at any hour of the day", () => {
    /* The case the clock cannot be moved to in a browser test: 18:00–21:00 is
       when Auto resolves to Evening, which is exactly when a phone must not
       show it. */
    const painted = new Set<ThemeLevel>();
    for (let h = 0; h < 24; h++) painted.add(levelForViewport(levelForHour(h), true));
    expect([...painted].sort()).toEqual(["light", "midnight"]);
  });

  it("still paints all three across a desktop day", () => {
    const painted = new Set<ThemeLevel>();
    for (let h = 0; h < 24; h++) painted.add(levelForViewport(levelForHour(h), false));
    expect([...painted].sort()).toEqual(["dark", "light", "midnight"]);
  });

  it("honours an explicit Evening from a desktop by showing the nearest it has", () => {
    /* The stored mode is not rewritten — someone who chose Evening on their
       laptop still has Evening there. The phone paints what it offers. */
    const at19 = new Date(2026, 8, 3, 19, 0, 0);
    expect(resolveLevel("dark", at19)).toBe("dark");
    expect(levelForViewport(resolveLevel("dark", at19), true)).toBe("midnight");
  });
});

describe("what the toggle offers", () => {
  it("gives a phone three stops and a desktop four", () => {
    expect(MODE_ORDER_COMPACT).toEqual(["auto", "light", "midnight"]);
    expect(MODE_ORDER).toEqual(["auto", "light", "dark", "midnight"]);
  });

  it("never offers a mode the phone would not paint", () => {
    /* Anything in the compact order must survive the collapse unchanged, or the
       picker would name a palette the screen then refuses to show. */
    for (const m of MODE_ORDER_COMPACT) {
      if (m === "auto") continue;
      expect(levelForViewport(m, true)).toBe(m);
    }
  });

  it("keeps a label for every mode, including the desktop-only one", () => {
    for (const m of MODE_ORDER) expect(THEME_LABELS[m]).toBeTruthy();
  });
});

describe("the first paint agrees with every paint after it", () => {
  /**
   * The pre-paint script in the root layout runs before React and sets
   * `data-theme` to stop a flash. It duplicates the resolution rules by
   * necessity — it cannot import them — so the duplication is what has to be
   * guarded: if the two disagree, the page paints one palette and then swaps.
   */
  const layout = readFileSync(
    fileURLToPath(new URL("../src/app/layout.tsx", import.meta.url)),
    "utf8"
  );

  it("collapses Evening in the no-flash script too", () => {
    expect(layout).toMatch(/lvl === 'dark' && window\.matchMedia\('\(max-width: 639px\)'\)\.matches/);
    expect(layout).toMatch(/lvl = 'midnight'/);
  });

  it("uses the same breakpoint the rest of the app does", () => {
    /* Tailwind's `sm`. A second idea of "small" would put the palette and the
       layout on different boundaries. */
    expect(COMPACT_QUERY).toBe("(max-width: 639px)");
    expect(layout).toContain("(max-width: 639px)");
  });

  it("keeps the same hour boundaries in both places", () => {
    /* `[\s\S]` rather than the `s` flag, which needs an es2018 target. */
    expect(layout).toMatch(/h>=6 && h<18[\s\S]*'light'[\s\S]*h>=18 && h<21[\s\S]*'dark'[\s\S]*'midnight'/);
    expect(levelForHour(6)).toBe("light");
    expect(levelForHour(17)).toBe("light");
    expect(levelForHour(18)).toBe("dark");
    expect(levelForHour(20)).toBe("dark");
    expect(levelForHour(21)).toBe("midnight");
    expect(levelForHour(5)).toBe("midnight");
  });
});

describe("the toggle's own behaviour", () => {
  const toggle = readFileSync(
    fileURLToPath(new URL("../src/components/theme/ThemeToggle.tsx", import.meta.url)),
    "utf8"
  );
  const provider = readFileSync(
    fileURLToPath(new URL("../src/components/theme/ThemeProvider.tsx", import.meta.url)),
    "utf8"
  );

  it("picks its loop from the viewport", () => {
    expect(toggle).toMatch(/const order = compact \? MODE_ORDER_COMPACT : MODE_ORDER;/);
  });

  it("does not throw away a mode it cannot show", () => {
    /**
     * A phone syncing a desktop that chose Evening holds a mode absent from its
     * own order. `indexOf` returns -1 and `(-1 + 1) % 3` is 0 — so the first tap
     * would have silently landed on Auto, discarding the choice rather than
     * advancing from it. It falls through to Night instead, which is the
     * palette the phone was already painting.
     */
    expect(toggle).toMatch(/setMode\(idx === -1 \? "midnight" : order\[\(idx \+ 1\) % order\.length\]\)/);
  });

  it("subscribes to the media query rather than reading it in render", () => {
    /* A media query is an external store, like `localStorage` above it. Read
       during render it is impure and would not update on a rotate or resize. */
    expect(provider).toMatch(/useSyncExternalStore\(subscribeCompact, readCompact, readServerCompact\)/);
    expect(provider).toMatch(/mq\.addEventListener\("change", onChange\)/);
    expect(provider).toMatch(/mq\.removeEventListener\("change", onChange\)/);
  });

  it("collapses the level it applies, not just the one it offers", () => {
    expect(provider).toMatch(/levelForViewport\(resolveLevel\(mode\), compact\)/);
  });
});
