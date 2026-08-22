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
/**
 * Routes with no session check, each with a stated reason.
 *
 * A reason, not a bare list: an endpoint reaching this set has stopped being
 * checked by the suite above, so the justification has to survive being read
 * back. Being here is an exemption from checking for a *session* — not from
 * being authorised at all, which the blocks below still insist on.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  "src/app/api/health/route.ts":
    "reports booleans and timings so a deploy can be verified before anyone " +
    "signs in. Reads no customer data.",
  "src/app/api/voice/[action]/route.ts":
    "a telephony webhook: the provider has no session, and the dialled number " +
    "is what resolves the tenant.",
  "src/app/api/stripe/webhook/route.ts":
    "a Stripe webhook: no session exists, and the request is authorised by its " +
    "signature instead. See the block below, which checks exactly that — this " +
    "is the only unauthenticated endpoint in the app that WRITES.",
};

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
    if (file in PUBLIC_ROUTES) continue;

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

describe("the Stripe webhook is authorised by signature", () => {
  /**
   * The one unauthenticated endpoint that writes.
   *
   * Without a verified signature, anybody who learns the URL can post a JSON
   * body putting their agency on the top tier, for free, permanently. It is a
   * single missing call between working billing and giving the product away, so
   * it is checked here rather than trusted to review.
   */
  const FILE = "src/app/api/stripe/webhook/route.ts";
  const body = () => bodyOf(read(FILE), "POST");

  it("verifies the signature before doing anything with the event", () => {
    const src = body();
    expect(src, "the webhook never verifies the signature").toMatch(/constructEvent\(/);

    // Before the database, not after. Verification that runs once the row is
    // written is not verification.
    expect(
      src.indexOf("constructEvent("),
      "the event reaches the database before its signature is checked"
    ).toBeLessThan(src.indexOf("handleStripeEvent"));
  });

  it("reads the raw body, because the signature covers the exact bytes", () => {
    const src = body();
    expect(src, "the body is parsed as JSON — that invalidates the signature").not.toMatch(
      /request\.json\(\)/
    );
    expect(src).toMatch(/request\.text\(\)/);
  });

  it("refuses when the signing secret is absent", () => {
    // A deployment with no secret must not fall back to trusting the caller.
    // That is the shape where billing "works" in a preview environment and the
    // endpoint is an open write in production.
    const src = body();
    expect(src).toMatch(/webhookSecret\(\)/);
    expect(src, "a missing secret does not stop the request").toMatch(
      /if\s*\(![^)]*secret[^)]*\)|!secret/
    );
  });

  it("rejects rather than reporting success when the signature is wrong", () => {
    const src = body();
    const rejection = src.slice(src.indexOf("catch"));
    expect(rejection, "a bad signature is not answered with an error status").toMatch(/400/);
  });
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
