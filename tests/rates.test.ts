import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every rate in the product means the same thing: a percentage, 0–100.
 *
 * It did not. Three producers returned a ratio (`won / decided`), one returned
 * a percentage, and one formatter — `${v}%` — was applied to all of them. So a
 * perfect win rate rendered as **"1%"**, two-in-three as "0.67%", and a 75%
 * show rate as "0.75%". Three headline figures on Reports and two on Meetings
 * were each a hundred times too small, and the chat assistant computed its own
 * correctly, so the two disagreed on screen.
 *
 * The failure needed two halves that were individually reasonable: a ratio is a
 * fine primitive, and appending "%" is a fine formatter. Nothing tested the
 * boundary between them, which is exactly where the unit was lost.
 */

const SRC = join(__dirname, "..", "src");

const walk = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((f) => {
        const full = join(dir, f);
        if (statSync(full).isDirectory()) return walk(full);
        return /\.(ts|tsx)$/.test(f) ? [full] : [];
      });

/** Fields whose value is rendered with a "%" sign somewhere. */
const RATE_FIELDS = ["winRate", "showRate", "conversion", "leadConversion"];

describe("a rate is a percentage everywhere it is produced", () => {
  const files = walk(join(SRC, "server"));

  it("finds the server modules (a suite matching nothing proves nothing)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("never assigns a bare division to a rate", () => {
    /**
     * `winRate: won / decided` is the shape of the bug. A percentage has to be
     * scaled, so any assignment of a rate field that divides without
     * multiplying by 100 is producing the wrong unit.
     */
    const offenders: string[] = [];

    for (const path of files) {
      const code = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      for (const field of RATE_FIELDS) {
        // The value assigned to the field, up to the end of that line.
        for (const m of code.matchAll(new RegExp(`\\b${field}:\\s*([^\\n]+)`, "g"))) {
          const value = m[1];
          // A type declaration, not an assignment.
          if (/^(number|string|boolean)/.test(value.trim())) continue;
          if (!value.includes("/")) continue;
          if (value.includes("100")) continue;

          offenders.push(`${path.split("/src/")[1]} → ${field}: ${value.trim().slice(0, 60)}`);
        }
      }
    }

    expect(
      offenders,
      `these produce a ratio where a percentage is printed:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});

describe("the formatters expect a percentage", () => {
  /**
   * The other half of the boundary. If a formatter starts multiplying by 100
   * while the producers already do, every rate becomes a hundred times too
   * LARGE — the same bug, mirrored, and just as invisible in review.
   */
  const formatters = [
    join(SRC, "app", "(app)", "reports", "page.tsx"),
    join(SRC, "app", "(app)", "meetings", "MeetingsView.tsx"),
  ];

  it("finds the formatters", () => {
    for (const f of formatters) expect(existsSync(f), `${f} is missing`).toBe(true);
  });

  it("appends the sign without rescaling", () => {
    for (const path of formatters) {
      const code = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const m = code.match(/rate\s*=?\s*\(?v: number \| null\)?\s*(?:=>|\{)[\s\S]{0,160}/);
      expect(m, `${path.split("/src/")[1]} has no rate formatter`).not.toBeNull();
      expect(
        /\*\s*100/.test(m![0]),
        `${path.split("/src/")[1]} rescales in the formatter as well as the producer — ` +
          `every rate would be 100× too large`
      ).toBe(false);
    }
  });

  it("shows a rate nobody has earned data for as a dash, not an unearned zero", () => {
    // A 0% win rate on a brand-new account is a real-looking figure that is not
    // real. Null has to survive all the way to the screen.
    for (const path of formatters) {
      const code = readFileSync(path, "utf8");
      expect(code).toMatch(/v === null \? "—"/);
    }
  });
});
