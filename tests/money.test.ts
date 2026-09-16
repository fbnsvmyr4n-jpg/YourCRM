import { describe, expect, it } from "vitest";
import { CURRENCIES, currencySymbol, formatMoney, isCurrency } from "../src/lib/money";

/** Amounts in the workspace's own currency, identically on server and browser. */

describe("formatting an amount", () => {
  it.each([
    [125_000_00, "whole", "R125,000"],
    [125_049, "whole", "R1,250"],
    [125_050, "whole", "R1,251"],
    [125_050, "exact", "R1,250.50"],
    [125_000, "exact", "R1,250"],
    [125_000, "cents", "R1,250.00"],
    [5, "cents", "R0.05"],
    [450_000, "compact", "R4.5K"],
    [1_200_000_00, "compact", "R1.2M"],
    [85_000, "compact", "R850"],
    [1_000_000, "compact", "R10K"],
    [0, "whole", "R0"],
  ] as const)("%d cents, %s → %s", (cents, style, text) => {
    expect(formatMoney(cents, "ZAR", style)).toBe(text);
  });

  it("puts the workspace's symbol in front, whatever it is", () => {
    expect(formatMoney(99_900, "GBP", "exact")).toBe("£999");
    expect(formatMoney(99_950, "EUR", "exact")).toBe("€999.50");
    expect(formatMoney(1_000_000_00, "NZD", "compact")).toBe("NZ$1M");
  });

  it("SHOWS A NEGATIVE AS NEGATIVE, with a true minus sign before the symbol", () => {
    expect(formatMoney(-250_000, "ZAR")).toBe("−R2,500");
    expect(formatMoney(-150, "USD", "cents")).toBe("−$1.50");
  });

  it("never prints NaN into a document", () => {
    expect(formatMoney(Number.NaN, "USD")).toBe("$0");
  });
});

describe("nothing prints a hard-coded dollar any more", () => {
  it("LEAVES A LITERAL $ ONLY WHERE YOURCRM BILLS IN DOLLARS", async () => {
    /* The workspace's money must come from its setting. The exceptions are
       what YourCRM itself charges — plans, usage, referral credit — which are
       genuinely dollars. A new "$" anywhere else is the old bug coming back. */
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = join(__dirname, "..", "src");
    const BILLED_IN_DOLLARS = new Set([
      "server/usage.ts",
      "components/billing/ReferralCard.tsx",
      "components/billing/BillingCard.tsx",
      "app/(app)/settings/actions.ts",
    ]);
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
      });
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = relative(root, file);
      if (BILLED_IN_DOLLARS.has(rel)) continue;
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      /* Four shapes a hard-coded dollar amount takes, and nothing else — a
         guard that flags ordinary template interpolation cries wolf and gets
         switched off:
           `$${x}`         a dollar before an interpolation, in a template
           ">${x}" "+${x}" a dollar before an expression in JSX text
           a JSX line that STARTS with ${x} (the dollar is the text)
           "$12"           a dollar before a literal number in a string
         SQL placeholders are the one legitimate "$" before a number or an
         interpolation: a quoted "$1" handed to `.replace`, or `$${i + 1}` /
         `$${next}` numbering parameters. Both are excluded by shape — a whole
         quoted "$<digits>" string, or an interpolation of a counter. */
      const hits = [
        ...(src.match(/\$\$\{(?!i \+|i\}|next|n\}|idx)/g) ?? []),
        ...(src.match(/["'`]\$\d(?!\d*["'`])/g) ?? []),
        ...(rel.endsWith(".tsx")
          ? [
              ...(src.match(/[>+]\$\{/g) ?? []),
              ...src.split("\n").filter((l) => /^\s*\$\{/.test(l) && !l.includes("`")),
            ]
          : []),
      ];
      if (hits.length) offenders.push(`${rel}: ${hits.map((h) => h.trim()).join(", ")}`);
    }
    expect(offenders, "an amount is printed with a hard-coded dollar sign").toEqual([]);
  });
});

describe("which currencies exist", () => {
  it("knows the rand, and refuses what is not on the list", () => {
    expect(isCurrency("ZAR")).toBe(true);
    expect(isCurrency("zar")).toBe(false);
    expect(isCurrency("XXX")).toBe(false);
    expect(currencySymbol("ZAR")).toBe("R");
  });

  it("has no two currencies sharing a code", () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-Z]{3}$/);
  });
});
