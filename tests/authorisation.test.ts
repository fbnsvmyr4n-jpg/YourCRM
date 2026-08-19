import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The control that would have caught the two Critical vulnerabilities.
 *
 * On 16 Aug 2026 an unauthenticated HTTP request deleted a record from the
 * production database, and `GET /api/search` returned all 53 records to anyone
 * who asked. Both had the same cause: **a surface was added without a guard,
 * and nothing checked.** The route guard in `(app)/layout.tsx` is a server
 * component — it decides whether a *page* renders and never runs for a server
 * action or a route handler, each of which is its own public endpoint.
 *
 * This is a static test on purpose. An HTTP exploit test proves a hole exists
 * once; this proves no hole exists *every time it runs*, in milliseconds, with
 * no server, no database and no build manifest. A new action that forgets
 * `requireUser()` fails CI before it can ever be deployed.
 */

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every `.ts`/`.tsx` under a directory, as paths relative to the repo root. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(relative(".", rel));
  }
  return out;
}

/** Every exported function in a `"use server"` module is a public POST endpoint. */
function exportedActions(src: string): string[] {
  return [...src.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
}

/**
 * One function's source, bounded by the next top-level `export`.
 *
 * Written after the first version of this test passed on deliberately
 * vulnerable code: it sliced a fixed 400-character window from the function
 * start, and a short function's window ran into the *next* function — which
 * was guarded. The assertion overlapped its own fallback and could not fail.
 * Bound the body, never guess a length.
 */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) return "";
  const rest = src.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

/**
 * Actions that are unauthenticated *by design* — the endpoints you must be able
 * to reach precisely because you are not signed in yet. Anything not on this
 * list must be guarded.
 */
const PUBLIC_ACTIONS = new Set([
  "signInAction",
  "signUpAction",
  "signOutAction",
  "requestResetAction",
  "resetPasswordAction",
]);

/**
 * Route handlers that are public by design, each for a stated reason:
 *  • health  — booleans only, must be reachable before sign-in to check a deploy
 *  • voice   — Twilio's webhook; authenticated by request signature instead,
 *              and refuses to answer at all when telephony is unconfigured
 */
const PUBLIC_ROUTES = new Set(["src/app/api/health/route.ts", "src/app/api/voice/[action]/route.ts"]);

/**
 * Server-action modules, found by the `"use server"` directive rather than by
 * filename.
 *
 * The first version globbed `**​/actions.ts` and silently missed
 * `(auth)/reset-actions.ts`. Its exports happen to be intentionally public, so
 * nothing was exposed — but a future `billing-actions.ts` would have been
 * invisible to this suite. A filename is a proxy; the directive is the thing.
 */
const appFiles = walk("src/app");
const actionFiles = appFiles.filter((f) => /^\s*["']use server["']/.test(read(f)));
const routeFiles = appFiles.filter((f) => /(^|\/)route\.tsx?$/.test(f) && f.includes("src/app/api"));

describe("every server action is authorised", () => {
  it("finds the action modules (a suite matching nothing proves nothing)", () => {
    expect(actionFiles.length).toBeGreaterThanOrEqual(9);
  });

  for (const file of actionFiles) {
    const src = read(file);
    const actions = exportedActions(src);

    for (const name of actions) {
      if (PUBLIC_ACTIONS.has(name)) continue;

      it(`${file.replace("src/app/", "")} → ${name}()`, () => {
        const body = bodyOf(src, name);

        // The guard must be the FIRST statement. A check that runs after a
        // write has already happened is not a guard.
        const firstStatement = body
          .slice(body.indexOf("{") + 1)
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));

        const guarded =
          // Bare guard, or one whose result is kept to attribute the write —
          // `const actor = await requireUser();` is the same check.
          /^(const \w+ = )?await requireUser\(\);$/.test(firstStatement ?? "") ||
          // The tenant-aware entry points. Both resolve identity BEFORE they do
          // anything else and throw when there is no session — the same
          // fail-closed behaviour as `requireUser`, plus the tenant. They are
          // accepted as guards because they are strictly stronger, not because
          // they are an exception: an action that establishes which customer it
          // is acting for has necessarily established who is asking.
          /^(const \w+ = )?await requireTenant\(\);$/.test(firstStatement ?? "") ||
          /^(return |const \w+ = )?await withCurrentTenant\(/.test(firstStatement ?? "") ||
          /^return withCurrentTenant\(/.test(firstStatement ?? "") ||
          // Settings actions predate `requireUser` and fail closed by returning
          // an error state instead of throwing, which suits their form shape.
          firstStatement === "const me = await getCurrentUser();";

        expect(
          guarded,
          `${name}() does not begin with an authorisation check — it is a public POST endpoint. First statement was: ${firstStatement}`
        ).toBe(true);
      });
    }
  }
});

describe("every API route is authorised", () => {
  it("finds the route handlers", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of routeFiles) {
    if (PUBLIC_ROUTES.has(file)) continue;

    it(`${file.replace("src/app/", "")} rejects unauthenticated callers`, () => {
      const src = read(file);

      // Check inside each HTTP handler, not the whole file. The first version
      // matched anywhere in the module and so was satisfied by the *import* of
      // `getCurrentUser` — it passed with the guard deleted. An import is not a
      // call.
      const handlers = [...src.matchAll(/^export async function (GET|POST|PUT|PATCH|DELETE)/gm)].map(
        (m) => m[1]
      );
      expect(handlers.length, `${file} exports no HTTP handler`).toBeGreaterThan(0);

      for (const verb of handlers) {
        const body = bodyOf(src, verb);
        const guarded = /await (getCurrentUser|requireUser|requireTenant)\(\)|withCurrentTenant\(/.test(body);
        expect(
          guarded,
          `${file} → ${verb}() serves data without checking for a session`
        ).toBe(true);
      }
    });
  }
});

describe("the guard itself", () => {
  it("the guard throws rather than returning null, so a forgetful caller fails closed", () => {
    /**
     * The property moved, not the requirement.
     *
     * `requireUser` lived in `session.ts` and answered "who is asking".
     * `requireTenant` replaced it and answers that AND "on whose data" — the
     * half that did not exist while there was one customer. It has to fail the
     * same way: a caller that forgets to check the result must still be
     * stopped, which only holds if it throws.
     */
    const src = read("src/server/tenant-session.ts");
    expect(src).toMatch(/export async function requireTenant/);
    expect(src).toMatch(/throw new Error/);

    // And it must not hand back a usable context when there is no session.
    expect(src, "the guard returns instead of throwing on a missing session").toMatch(
      /if \(!user\)[\s\S]{0,200}throw new Error/
    );
  });
});
