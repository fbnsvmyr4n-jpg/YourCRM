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
const RATE_FIELDS = ["winRate", "showRate", "conversion", "leadConversion", "lossRate"];

/**
 * Names that end in "Rate" but are not percentages.
 *
 * Empty, and expected to stay that way. It exists so that the discovery test
 * below has an honest way to say "this one really is exempt" rather than being
 * weakened when something legitimate turns up.
 */
const NOT_PERCENTAGES = new Set<string>([]);

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

  it("knows about every field that is named like a rate", () => {
    /**
     * The list above is hand-written, and that is how this bug came back.
     *
     * `lossRate` was added to the meeting analytics after this guard was
     * written, was never added to `RATE_FIELDS`, and duly shipped as
     * `lossTotal / decided` — sitting directly beneath a comment reading
     * "Percentages, 0-100" and directly beside two neighbours that both scale
     * correctly. It rendered "0.5% Loss Rate" above the sentence "1 of 2
     * decided opportunities were lost".
     *
     * A guard that only checks what somebody remembered to enrol is a guard
     * against the bugs already found. So the enrolment is checked too: anything
     * named `somethingRate` must be in the list, and the next one fails here
     * until it is.
     */
    const named = new Set<string>();
    for (const path of files) {
      const code = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(/\b(\w+Rate)\s*:/g)) named.add(m[1]);
    }

    const missing = [...named].filter(
      (f) => !RATE_FIELDS.includes(f) && !NOT_PERCENTAGES.has(f)
    );

    expect(
      missing,
      `these are named like rates but are not checked above — add them to ` +
        `RATE_FIELDS, or to NOT_PERCENTAGES if they genuinely are not percentages:\n${missing.join("\n")}`
    ).toEqual([]);

    // And the discovery itself has to be finding things, or it proves nothing.
    expect(named.size, "the scan found no rate fields at all").toBeGreaterThan(2);

    /* An exemption cannot cover something that is also enrolled. Without this,
       the whole check above is switched off by moving names into the exemption
       list — which is the one edit that makes a failing guard go quiet while
       looking like maintenance. */
    const both = RATE_FIELDS.filter((f) => NOT_PERCENTAGES.has(f));
    expect(both, "these are listed as rates AND as exempt from being rates").toEqual([]);
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
