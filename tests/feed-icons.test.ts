import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { iconMap, toneStyles } from "../src/components/ui/tone";

/**
 * Every icon and tone the feed emits must exist.
 *
 * The failure is not a fallback, it is a crash: an unknown key makes the row
 * render `undefined` as a React component and the whole dashboard throws. The
 * type already carried a comment saying so, and the first version of the
 * rewritten feed still emitted "sparkles" and "teal" — neither of which
 * exists. A comment is not a check.
 *
 * Static, because the alternative is rendering the page to find out.
 */

const FEED = readFileSync(join(__dirname, "..", "src", "server", "feed.ts"), "utf8");

const literals = (property: string) =>
  [...FEED.matchAll(new RegExp(`${property}:\\s*(?:[^,\\n]*\\?\\s*)?"([^"]+)"(?:\\s*:\\s*"([^"]+)")?`, "g"))]
    .flatMap((m) => [m[1], m[2]])
    .filter((v): v is string => Boolean(v));

describe("the activity feed can only emit keys that exist", () => {
  it("finds the literals (a check matching nothing proves nothing)", () => {
    expect(literals("icon").length).toBeGreaterThan(3);
    expect(literals("tone").length).toBeGreaterThan(3);
  });

  it("emits only icons the map has", () => {
    for (const icon of literals("icon")) {
      expect(Object.keys(iconMap), `"${icon}" is not in iconMap — the row would throw`).toContain(icon);
    }
  });

  it("emits only tones the palette has", () => {
    for (const tone of literals("tone")) {
      expect(Object.keys(toneStyles), `"${tone}" is not a Tone`).toContain(tone);
    }
  });
});
