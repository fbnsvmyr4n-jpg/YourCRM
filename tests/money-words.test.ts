import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * One name, one number.
 *
 * The Deals board and Reports both showed a figure called "Open Pipeline" and
 * they were different: the board counts Discovery and Demo, Reports counts
 * every open stage including Prospect. Both are defensible; sharing a name is
 * not — a business comparing the two screens sees a discrepancy with no
 * explanation, and stops trusting the numbers.
 *
 * Found on 18 Sep 2026 by driving the app against a fixture whose totals were
 * worked out on paper (scripts/dev-seed.ts).
 */

const APP = join(__dirname, "..", "src", "app");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

describe("money labels say the same thing everywhere", () => {
  const files = walk(APP).map((p) => ({
    path: relative(APP, p),
    /* Comments quote the bug they describe, so they are stripped first. */
    src: readFileSync(p, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, ""),
  }));

  it("finds the screens (a guard matching nothing proves nothing)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("ONLY ONE SCREEN CALLS A FIGURE “Open Pipeline”", () => {
    const users = files.filter((f) => f.src.includes("Open Pipeline")).map((f) => f.path);
    expect(users, "two screens show different money under the same name").toEqual([join("(app)", "reports", "page.tsx")]);
  });
});
