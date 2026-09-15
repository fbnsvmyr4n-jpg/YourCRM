import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every colour token a screen uses has to exist.
 *
 * An undefined CSS custom property does not fail. `background: var(--surface-2)`
 * with no `--surface-2` anywhere simply computes to transparent, so the surface
 * vanishes and the card behind it shows through. That is how five names —
 * `--surface-2`, `--sunken`, `--rule-soft`, `--muted`, `--faint` — sat in about
 * two dozen components (team rows, billing plan cards, pricing items, project
 * tasks, holiday rows, a contact's status pill) rendering as nothing, with no
 * error, no warning and a green test suite.
 *
 * So this reads the code the way the browser would: every `var(--name)` with no
 * fallback must be declared somewhere it can come from.
 */

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");
const GLOBALS = readFileSync(join(SRC, "app", "globals.css"), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

const files = walk(SRC);

/** Declared in a stylesheet: `--name:` at the start of a declaration. */
const declaredInCss = new Set(
  [...GLOBALS.matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])
);

/** Set inline from components: `["--d" as string]: …` or `"--glow": …`. */
const setInline = new Set(
  files.flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(/["'`](--[a-z0-9-]+)["'`]\s*(?:as\s+string\s*\])?\s*:/g)].map(
      (m) => m[1]
    )
  )
);

/** Set at runtime by `element.style.setProperty("--name", …)`. */
const setByScript = new Set(
  files.flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(/setProperty\(\s*["'`](--[a-z0-9-]+)["'`]/g)].map((m) => m[1])
  )
);

/**
 * Declared by Next's font loader: `Geist({ variable: "--font-geist-sans" })`
 * puts that property on <html> through a generated class. Read from the
 * loader call itself rather than listed by name, so a font added or renamed
 * later is picked up without anyone editing this test.
 */
const setByFontLoader = new Set(
  files.flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(/variable:\s*["'`](--[a-z0-9-]+)["'`]/g)].map((m) => m[1])
  )
);

/**
 * The login sky is published from one place, under a generated name —
 * `--env-${key}` in `src/lib/environment/publish.ts` — so its names cannot be
 * found by reading for literals. Allowed by prefix, and only because that file
 * still generates them; the test below fails if it stops.
 */
const GENERATED_PREFIX = "--env-";

/** Uses with no fallback — the only ones that can compute to nothing. */
function usesWithoutFallback(): Array<{ token: string; file: string }> {
  return files.flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map((m) => ({
      token: m[1],
      file: relative(ROOT, f),
    }))
  );
}

describe("colour tokens", () => {
  it("finds the stylesheet's tokens and the screens' uses (a scan matching nothing proves nothing)", () => {
    expect(declaredInCss.size).toBeGreaterThan(30);
    expect(usesWithoutFallback().length).toBeGreaterThan(100);
  });

  it("EVERY TOKEN USED WITHOUT A FALLBACK IS DEFINED SOMEWHERE", () => {
    const missing = new Map<string, Set<string>>();
    for (const { token, file } of usesWithoutFallback()) {
      const defined =
        declaredInCss.has(token) ||
        setInline.has(token) ||
        setByScript.has(token) ||
        setByFontLoader.has(token) ||
        token.startsWith(GENERATED_PREFIX);
      if (!defined) {
        if (!missing.has(token)) missing.set(token, new Set());
        missing.get(token)!.add(file);
      }
    }
    const report = [...missing].map(([t, fs]) => `${t} — used in ${[...fs].join(", ")}`);
    expect(report, `undefined tokens render as nothing:\n${report.join("\n")}`).toEqual([]);
  });

  it("still generates the login tokens the prefix allowance depends on", () => {
    const publish = readFileSync(join(SRC, "lib", "environment", "publish.ts"), "utf8");
    expect(publish).toMatch(/`--env-\$\{/);
  });

  it("defines the surfaces in every theme, not only the first", () => {
    /* A tint over a card must go darker in the light theme and lighter in the
       dark ones. Defining a surface once, at the root, would leave it right in
       one theme and invisible in another. */
    for (const theme of ["light", "dark", "midnight"]) {
      const selector = theme === "light" ? `:root,\\s*\\[data-theme="light"\\]` : `\\[data-theme="${theme}"\\]`;
      const blocks = [...GLOBALS.matchAll(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
      const body = blocks.join("\n");
      for (const token of ["--surface-2", "--sunken", "--rule-soft"]) {
        expect(body, `${token} is not defined for the ${theme} theme`).toMatch(new RegExp(`${token}\\s*:`));
      }
    }
  });
});
