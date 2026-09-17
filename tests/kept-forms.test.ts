import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A refused save must not throw away what was typed.
 *
 * React 19 resets every uncontrolled field once a `<form action={…}>` action
 * finishes, refused or not. Found on 18 Sep 2026: the custom-field form came
 * back saying "A choice list needs at least one choice" with the name the
 * person had just typed wiped, and a public enquiry refused for a mistyped
 * phone number would have lost the visitor's whole message.
 *
 * Every form backed by a server action goes through `useKeptForm`, which
 * submits via onSubmit and clears only after a save that worked. This keeps a
 * new form from quietly bringing the reset back.
 */

const SRC = join(__dirname, "..", "src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

describe("forms keep what was typed", () => {
  const files = walk(SRC).map((p) => ({ path: relative(SRC, p), src: readFileSync(p, "utf8") }));

  it("finds the hook (a guard matching nothing proves nothing)", () => {
    expect(files.some((f) => f.path === join("lib", "use-kept-form.ts"))).toBe(true);
    expect(files.filter((f) => f.src.includes("useKeptForm(") || f.src.includes("useKeptForm<")).length).toBeGreaterThan(15);
  });

  it("NOTHING CALLS useActionState DIRECTLY — it goes through useKeptForm", () => {
    const offenders = files
      .filter((f) => f.path !== join("lib", "use-kept-form.ts"))
      .filter((f) => /\buseActionState\s*[<(]/.test(f.src))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
