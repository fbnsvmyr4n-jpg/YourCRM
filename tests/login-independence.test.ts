import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Signing in must not depend on the sky.
 *
 * §7 and §26 both say it in different words: location is an enhancement, never
 * a prerequisite, and authentication continues in every failure case. The
 * location ladder is already tested against denial, timeouts, offline fetches
 * and a browser returning nonsense — but all of that proves the ladder recovers,
 * not that authentication was never standing behind it in the first place.
 *
 * This proves the stronger thing, structurally: the modules that authenticate
 * do not import the modules that draw. Nothing in the environment can throw on
 * the path that checks a password, because none of it is on that path — and no
 * future refactor can quietly put it there without turning this red.
 *
 * A test over the import GRAPH rather than over behaviour, because that is the
 * only form that stays true. A behavioural test proves the current code path is
 * clean; the graph proves no path exists.
 */

const ROOT = resolve(".");
const ENVIRONMENT = ["src/lib/environment", "src/lib/solar", "src/components/login"];

/** Everything the sign-in path is made of. */
const AUTH_ENTRY_POINTS = [
  "src/app/(auth)/actions.ts",
  "src/app/(auth)/reset-actions.ts",
  "src/server/auth.ts",
];

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

/**
 * Resolve an import specifier to a file in this project, or null.
 *
 * Handles the `@/` alias and the usual extension guessing. Package imports
 * resolve to null and stop the walk — a dependency's own graph is not ours and
 * cannot reach back into the environment.
 */
function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(ROOT, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(join(ROOT, from)), specifier);
  else return null;

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        if (readFileSync(candidate, "utf8")) return candidate.slice(ROOT.length + 1);
      } catch {
        // A directory, not a file. Keep looking.
      }
    }
  }
  return null;
}

/**
 * Every project file reachable from an entry point.
 *
 * Type-only imports are excluded. A `import type` is erased entirely at build
 * time — it cannot execute, cannot throw, and cannot pull a module into the
 * bundle. Counting them would fail this test for a dependency that does not
 * exist at runtime.
 */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = read(file);
    const pattern = /^\s*import\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/gm;
    for (const match of source.matchAll(pattern)) {
      const isTypeOnly = Boolean(match[1]) || /^\{\s*type\s/.test(match[2]);
      if (isTypeOnly) continue;
      const resolved = resolveImport(file, match[3]);
      if (resolved) queue.push(resolved);
    }
  }

  return seen;
}

describe("authentication does not import the environment", () => {
  for (const entry of AUTH_ENTRY_POINTS) {
    it(`${entry} reaches nothing in the scene`, () => {
      const graph = importGraph(entry);
      const offenders = [...graph].filter((file) =>
        ENVIRONMENT.some((dir) => file.startsWith(dir))
      );
      expect(
        offenders,
        `${entry} can now fail because of the login backdrop`
      ).toEqual([]);
    });
  }

  it("resolves both an aliased and a relative import", () => {
    /**
     * The counter-check that actually works, and the second attempt at it.
     *
     * The first asserted only that the graph was non-empty and reached
     * `src/server/`. Breaking relative-path resolution entirely left that
     * passing, because the alias form still resolved — so a module reaching the
     * environment through `../../lib/solar` would have been invisible while
     * every test stayed green. A mutation found it.
     *
     * Both styles are now exercised by name, so neither can quietly stop
     * working.
     */
    expect(
      resolveImport("src/app/(auth)/actions.ts", "@/server/auth"),
      "the @/ alias no longer resolves"
    ).toBe("src/server/auth.ts");

    expect(
      resolveImport("src/lib/environment/model.ts", "./curves"),
      "relative imports no longer resolve"
    ).toBe("src/lib/environment/curves.ts");

    expect(
      resolveImport("src/lib/environment/model.ts", "../solar/suncalc"),
      "parent-relative imports no longer resolve"
    ).toBe("src/lib/solar/suncalc.ts");

    // And a package import must stop the walk rather than resolving to nonsense.
    expect(resolveImport("src/lib/solar/suncalc.ts", "suncalc")).toBeNull();
  });

  it("walks a real graph, not an empty one", () => {
    /**
     * The counter-check, and it is not decoration. If `resolveImport` stopped
     * resolving anything — an alias change, a moved file — every test above
     * would pass by walking a graph of one file, and would keep passing while
     * the dependency it exists to forbid was introduced.
     */
    const graph = importGraph("src/app/(auth)/actions.ts");
    expect(graph.size, "the import walker resolved nothing").toBeGreaterThan(3);
    expect([...graph].some((f) => f.startsWith("src/server/"))).toBe(true);
  });

  it("would notice if the environment were imported", () => {
    // Proving the detector detects. The scene's own provider obviously reaches
    // the environment; if walking IT finds nothing, the check above is inert.
    const graph = importGraph("src/components/login/EnvironmentProvider.tsx");
    const found = [...graph].filter((file) => ENVIRONMENT.some((dir) => file.startsWith(dir)));
    expect(found.length, "the walker cannot see environment imports at all").toBeGreaterThan(0);
  });
});

describe("the sign-in form itself", () => {
  it("submits through a server action, not through anything the scene owns", () => {
    /**
     * The form posts to `signInAction`. The backdrop is a sibling in the tree,
     * not an ancestor of the form's submission path — so even a component that
     * threw while rendering the sky would leave the credentials path intact.
     */
    const page = read("src/app/login/page.tsx");
    expect(page).toMatch(/action=\{formAction\}/);
    expect(page).toMatch(/useActionState<AuthState, FormData>\(signInAction/);
  });

  it("does not await the environment before rendering the form", () => {
    // No `await` on anything environmental in the page: the form is present in
    // the first paint whether or not the sky ever resolves.
    const page = read("src/app/login/page.tsx");
    expect(page).not.toMatch(/await\s+(resolveLocation|solarSnapshot|environmentFor)/);
  });

  it("keeps the backdrop out of the form's own subtree", () => {
    // The scene renders alongside the form rather than wrapping it, so a
    // failure in the sky cannot take the fields down with it.
    const page = read("src/app/login/page.tsx");
    const sceneAt = page.indexOf("<OrbitScene");
    const formAt = page.indexOf("<form");
    expect(sceneAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(sceneAt);
    expect(page).not.toMatch(/<OrbitScene[^/]*>[\s\S]*<form/);
  });
});
