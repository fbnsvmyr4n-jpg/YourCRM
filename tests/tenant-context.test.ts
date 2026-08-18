import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The tenant context layer.
 *
 * `schema.sql` declares the row-level policies; they are inert until something
 * sets `app.sub_account_id`. `tenant.ts` is the only thing that sets it, so
 * these tests guard the properties that make that single point of enforcement
 * actually hold — the ones whose failure is silent rather than loud.
 */

const SERVER = join(__dirname, "..", "src", "server");
const TENANT = readFileSync(join(SERVER, "tenant.ts"), "utf8");

describe("tenant scoping cannot leak between requests", () => {
  it("sets the tenant variable transaction-locally, never session-wide", () => {
    /**
     * The pool hands one physical connection to unrelated requests. A
     * session-level `SET` survives COMMIT, so the next request to borrow that
     * connection inherits the previous tenant's id and reads their data —
     * the precise leak the policies exist to prevent, reintroduced by the
     * mechanism meant to enforce them. It would appear only under connection
     * reuse, i.e. under load, i.e. in production and not in testing.
     */
    expect(TENANT, "tenant scope is not set with set_config(..., true)").toMatch(
      /set_config\('app\.sub_account_id', \$1, true\)/
    );
    expect(
      /\bSET\s+(?!LOCAL)/.test(TENANT.replace(/--.*|\/\*[\s\S]*?\*\//g, "")),
      "a session-level SET would outlive the transaction and follow the pooled connection into the next request"
    ).toBe(false);
  });

  it("passes the tenant id as a bind parameter, not interpolated SQL", () => {
    expect(TENANT).not.toMatch(/SET LOCAL[^\n]*\$\{/);
    expect(TENANT).not.toMatch(/app\.sub_account_id[^\n]*\+\s*\w/);
  });

  it("releases the connection on every path, including a throw", () => {
    expect(TENANT, "a connection leaked on error exhausts a pool of 3 within three failures").toMatch(
      /finally\s*\{[\s\S]*?client\.release\(\)/
    );
    expect(TENANT).toMatch(/catch[\s\S]*?ROLLBACK/);
  });

  it("fails closed when identity is missing", () => {
    // An empty id makes current_setting return '', which matches no rows — so
    // a broken request looks like an empty account. A silent wrong answer is
    // worse than a loud failure; this must throw.
    expect(TENANT).toMatch(/if \(!ctx\.subAccountId[\s\S]*?throw new Error/);
  });
});

describe("no query can be issued outside a tenant", () => {
  function serverFiles(): string[] {
    const out: string[] = [];
    for (const name of readdirSync(SERVER)) {
      const path = join(SERVER, name);
      if (statSync(path).isFile() && name.endsWith(".ts")) out.push(path);
    }
    return out;
  }

  it("finds the server modules (a suite matching nothing proves nothing)", () => {
    expect(serverFiles().length).toBeGreaterThan(5);
  });

  it("only tenant.ts and db.ts reach the connection pool", () => {
    /**
     * `withTenant` is the only place `app.sub_account_id` gets set, so a module
     * that opens its own connection runs with the variable unset and its
     * queries see nothing — or, once FORCE is in place and someone "fixes" the
     * empty results by connecting differently, sees everything.
     *
     * db.ts is allowed: it owns the pool. Its legacy `crm_collections` helpers
     * are the pre-tenancy path and are on the migration list.
     */
    const allowed = new Set(["tenant.ts", "db.ts"]);
    for (const path of serverFiles()) {
      const name = path.split("/").pop()!;
      if (allowed.has(name)) continue;
      const src = readFileSync(path, "utf8");
      expect(src, `${name} imports the pool directly, bypassing tenant scoping`).not.toMatch(
        /getPool\s*\(/
      );
      expect(src, `${name} constructs its own pg Pool, which would bypass row-level security`).not.toMatch(
        /new Pool\s*\(/
      );
    }
  });

  it("the querier cannot be constructed outside tenant.ts", () => {
    // A unique-symbol brand: repositories must be *handed* a querier, so they
    // cannot quietly acquire one. This is what makes an unscoped query a type
    // error rather than something a developer has to remember not to write.
    expect(TENANT).toMatch(/declare const \w+: unique symbol/);
    expect(TENANT).toMatch(/readonly \[\w+\]: true/);
    expect(TENANT, "the brand must not be exported, or anything could forge a querier").not.toMatch(
      /export (declare )?const \w+: unique symbol/
    );
  });
});
