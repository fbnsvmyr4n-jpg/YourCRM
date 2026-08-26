import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Moving between the pages under the sky must not rebuild the sky.
 *
 * Reported as: clicking "Create an account" showed the OLD login screen for a
 * moment before the new one appeared. That was not a caching problem. Each page
 * mounted its own `<OrbitScene />`, and the links between them were plain
 * anchors — so every navigation was a full document reload that threw away the
 * WebGL context, re-decoded every texture, re-parsed the star catalogue, and
 * showed the CSS fallback for the second or two all of that takes. The "old
 * version" was the fallback scene.
 *
 * Both halves have to hold, and either one alone fixes nothing:
 *
 *  - the scene lives in a LAYOUT, so React keeps it mounted across navigation;
 *  - the links are CLIENT-SIDE, because a plain `<a href>` reloads the document
 *    and destroys the layout the first half exists to preserve.
 */

const dir = fileURLToPath(new URL("../src/app/(orbit)", import.meta.url));

function pagesUnderOrbit(): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".tsx") && entry !== "layout.tsx") out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe("the scene survives navigation", () => {
  it("mounts the scene once, in the layout", () => {
    const layout = readFileSync(join(dir, "layout.tsx"), "utf8");
    expect(layout).toMatch(/<OrbitScene\s*\/>/);
  });

  it("never mounts a second scene inside a page", () => {
    /* A page rendering its own copy puts two canvases on screen and defeats the
       layout entirely — the per-page one still unmounts on navigation. */
    for (const file of pagesUnderOrbit()) {
      expect(readFileSync(file, "utf8"), `${file} should not mount its own scene`)
        .not.toMatch(/<OrbitScene\s*\/>/);
    }
  });

  it("links between these pages without reloading the document", () => {
    /* The half that is easy to undo later: someone writes `<a href="/signup">`
       because it is shorter, and the flash comes back with no error anywhere. */
    for (const file of pagesUnderOrbit()) {
      const source = readFileSync(file, "utf8");
      const anchors = [...source.matchAll(/<a\s+[^>]*href=["']\/(login|signup|reset-password)/g)];
      expect(anchors.map((m) => m[0]), `${file} must use <Link>, not <a>`).toEqual([]);
    }
  });

  it("keeps the URLs these pages already had", () => {
    // A route group is parentheses precisely so it does not appear in the path.
    // If this ever became a real segment, every existing link would 404.
    expect(dir).toMatch(/\(orbit\)$/);
    for (const p of ["login", "signup", "reset-password"]) {
      expect(() => statSync(join(dir, p)), `/${p} should exist under the group`).not.toThrow();
    }
  });
});
