import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { logAuth, logDenied, logWrite } from "../src/server/log";

/**
 * A log that leaks is worse than no log — it turns the audit trail into a second
 * copy of whatever was sensitive. These tests hold that line, and check that the
 * events which make a breach reconstructable are actually wired up.
 */

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(e.name)) out.push(relative(".", rel));
  }
  return out;
}

/** Captures a single emitted line without printing it during the test run. */
function capture(fn: () => void, method: "info" | "warn" | "error" = "info") {
  const spy = vi.spyOn(console, method).mockImplementation(() => {});
  fn();
  const line = spy.mock.calls.at(-1)?.[0] as string | undefined;
  return line ? JSON.parse(line) : undefined;
}

afterEach(() => vi.restoreAllMocks());

describe("the log never carries secrets", () => {
  it("redacts anything that looks like a credential, whatever the caller passes", () => {
    const out = capture(
      () =>
        logWrite("update", "user", {
          id: "u1",
          actor: "u1",
          // A careless caller — the logger must not trust the call site.
          ...({ password: "hunter2", sessionToken: "abc.def", apiKey: "sk-live-x" } as object),
        }),
      "info"
    );
    const line = JSON.stringify(out);
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("abc.def");
    expect(line).not.toContain("sk-live-x");
    expect(line).toContain("[redacted]");
  });

  it("never spreads an object into the log, so a whole record cannot leak", () => {
    const out = capture(
      () =>
        logWrite("delete", "contact", {
          id: "c1",
          actor: "u1",
          ...({ record: { email: "someone@example.com", phone: "+27 71 443 8872" } } as object),
        }),
      "warn"
    );
    const line = JSON.stringify(out);
    expect(line).not.toContain("example.com");
    expect(line).not.toContain("443 8872");
    expect(line).toContain("[object]");
  });
});

describe("the log records what an incident needs", () => {
  it("a denied request identifies the surface and the reason", () => {
    const out = capture(() => logDenied("server-action", "no valid session"), "warn");
    expect(out.event).toBe("access.denied");
    expect(out.surface).toBe("server-action");
    expect(out.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("a deletion identifies the record and who did it", () => {
    const out = capture(() => logWrite("delete", "deal", { id: "d1", actor: "u9" }), "warn");
    expect(out.event).toBe("write.deal.delete");
    expect(out.id).toBe("d1");
    expect(out.actor).toBe("u9");
    expect(out.level).toBe("warn");
  });

  it("a failed sign-in keeps the targeted email — an attack cannot be traced without it", () => {
    const out = capture(() => logAuth("signin.failed", { email: "a@b.com" }), "warn");
    expect(out.event).toBe("auth.signin.failed");
    expect(out.email).toBe("a@b.com");
  });
});

describe("the events are actually wired up", () => {
  it("the tenant guard logs a denial before throwing", () => {
    /**
     * An unauthenticated caller reaching a guarded path must leave a trace.
     * Previously it left none, on a public URL, for three weeks.
     *
     * The slice below used to start from a bare `indexOf`, which returns -1
     * when the name is not found — so after `requireUser` became
     * `requireTenant` the test examined the last character of the file and
     * compared "\n" against the pattern. It failed here, but the same shape
     * silently passes whenever the assertion is a negative one. The index is
     * checked first now.
     */
    const src = read("src/server/tenant-session.ts");
    const at = src.indexOf("export async function requireTenant");
    expect(at, "requireTenant is not where this test expects it").toBeGreaterThan(-1);
    expect(src.slice(at)).toMatch(/logDenied\(/);
  });

  it("a rejected sub-account switch is logged too", () => {
    // The other denial worth a trace: a cookie naming somebody else's client
    // is either a stale value or an attempt, and both should be visible.
    const src = read("src/server/tenant-session.ts");
    const at = src.indexOf("export async function resolveSubAccount");
    expect(at, "resolveSubAccount is not where this test expects it").toBeGreaterThan(-1);
    expect(src.slice(at)).toMatch(/logDenied\(/);
  });

  it("every delete action records who deleted what", () => {
    const deleteActions = walk("src/app")
      .filter((f) => /^\s*["']use server["']/.test(read(f)))
      .flatMap((f) => {
        const src = read(f);
        return [...src.matchAll(/^export async function (delete\w+Action)/gm)].map((m) => ({
          file: f,
          name: m[1],
          src,
        }));
      });

    // A suite that finds nothing proves nothing.
    expect(deleteActions.length).toBeGreaterThanOrEqual(5);

    for (const { file, name, src } of deleteActions) {
      const start = src.indexOf(`export async function ${name}`);
      const next = src.indexOf("\nexport ", start + 1);
      const body = src.slice(start, next < 0 ? undefined : next);
      expect(body, `${file} → ${name}() deletes a record without logging it`).toMatch(
        /logWrite\("delete"/
      );
    }
  });

  it("sign-in, sign-up and sign-out are all recorded", () => {
    const src = read("src/app/(auth)/actions.ts");
    for (const event of ["signin.ok", "signin.failed", "signup.ok", "signout", "ratelimited"]) {
      expect(src, `auth event "${event}" is never logged`).toContain(`"${event}"`);
    }
  });
});
