import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * No server file calls a function that lives in a client module.
 *
 * This happened twice. `decorateDeal` was exported from `DealsBoard.tsx` and
 * called by the deals page; `decorate` was exported from `ContactsView.tsx` and
 * called by the contacts page. Both carry "use client", so Next refuses:
 * "Attempted to call decorateDeal() from the server but decorateDeal is on the
 * client" — and the whole page renders its error boundary.
 *
 * It is a poor failure to be caught by. `npm run build` compiles it happily and
 * `tsc` sees nothing wrong, because the types are perfectly valid; the boundary
 * is a runtime property of the module graph. So it survives every gate and
 * surfaces the moment somebody opens the page.
 *
 * Importing a COMPONENT across the boundary is normal and correct — that is
 * what the boundary is for. Importing a plain function and calling it is not.
 */

const APP = join(__dirname, "..", "src", "app");

const walk = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((f) => {
        const full = join(dir, f);
        if (statSync(full).isDirectory()) return walk(full);
        return /\.tsx?$/.test(f) ? [full] : [];
      });

const isClientModule = (path: string) =>
  /^\s*["']use client["']/.test(readFileSync(path, "utf8"));

/** Resolve a relative import to the file it actually names. */
function resolve(from: string, spec: string): string | null {
  const base = join(from, "..", spec);
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

describe("the server never calls into a client module", () => {
  const files = walk(APP);

  it("finds the application files (a suite matching nothing proves nothing)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("imports no callable from a client module into a server file", () => {
    const offenders: string[] = [];

    for (const path of files) {
      if (isClientModule(path)) continue;

      const src = readFileSync(path, "utf8");
      for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g)) {
        const target = resolve(path, m[2]);
        if (!target || !isClientModule(target)) continue;

        const named = m[1]
          .split(",")
          .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean)
          // `import type` and inline `type X` cross the boundary freely: types
          // are erased and nothing is called at runtime.
          .filter((n) => !n.startsWith("type "));

        // A Capitalised export is a component, which is exactly what the
        // boundary exists to pass. A lowercase one is a function somebody
        // means to call.
        const callables = named.filter((n) => /^[a-z]/.test(n));

        if (callables.length > 0 && !/^import\s+type/.test(m[0])) {
          offenders.push(
            `${path.split("/app/")[1]} imports ${callables.join(", ")} from "${m[2]}"`
          );
        }
      }
    }

    expect(
      offenders,
      `these call into a client module from the server, which fails at runtime ` +
        `while the build and tsc both pass:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("keeps the decorators in server modules, where the pages can use them", () => {
    // Each of these was moved out of a client component after breaking a page.
    for (const name of ["decorate-deal", "decorate-contact"]) {
      const path = join(__dirname, "..", "src", "server", `${name}.ts`);
      expect(existsSync(path), `${name}.ts is gone — has it moved back?`).toBe(true);
      expect(isClientModule(path), `${name}.ts became a client module`).toBe(false);
    }
  });
});
