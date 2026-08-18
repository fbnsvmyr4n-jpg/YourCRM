import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

describe("enums have one source of truth", () => {
  /**
   * Every one of these exists twice: as a CHECK constraint in the schema and as
   * an `as const` array in TypeScript. That duplication is unavoidable — the
   * database must reject bad data and the compiler must reject bad code — so
   * the pair is pinned together here instead of being trusted.
   *
   * Not hypothetical: `role` had already drifted to four values that the schema
   * rejected, and nothing caught it until the first real INSERT failed at
   * runtime. Same defect class as `as SomeType` standing in for validation.
   */
  function checkConstraint(column: string): string[] {
    const schema = readFileSync(join(SERVER, "schema.sql"), "utf8");
    const re = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`);
    const m = schema.match(re);
    expect(m, `no CHECK constraint found for ${column}`).toBeTruthy();
    return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  }

  function tsEnum(src: string, name: string): string[] {
    const m = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`));
    expect(m, `no exported ${name} array found`).toBeTruthy();
    return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  }

  const DEALS = readFileSync(join(SERVER, "repos", "deals.ts"), "utf8");

  it("deal stages match the CHECK constraint exactly", () => {
    expect(tsEnum(DEALS, "STAGES")).toEqual(checkConstraint("stage"));
  });

  it("deal sources match the CHECK constraint exactly", () => {
    expect(tsEnum(DEALS, "SOURCES")).toEqual(checkConstraint("source"));
  });

  it("the open and post-close stage groups are real stages, and do not overlap", () => {
    // These two drive "is this a lead" and "is this revenue". A typo in either
    // would not fail any query — it would quietly shrink a number on a report.
    const stages = new Set(tsEnum(DEALS, "STAGES"));
    const open = tsEnum(DEALS, "OPEN_STAGES");
    const closed = tsEnum(DEALS, "CLOSED_WON_STAGES");

    for (const s of [...open, ...closed]) {
      expect(stages.has(s), `"${s}" is not a real stage`).toBe(true);
    }
    expect(open.filter((s) => closed.includes(s)), "a stage is both open and won").toEqual([]);
    expect(stages.has("lost"), "there is no terminal lost stage").toBe(true);
  });

  it("matches the CHECK constraint on users.role exactly", () => {
    /**
     * These had already drifted: the schema allowed owner/admin/member while
     * the TypeScript union listed four different values, so the first real
     * insert failed. Same defect class as `as SomeType` standing in for
     * validation — a compile-time claim nothing checked against the database.
     */
    const schema = readFileSync(join(SERVER, "schema.sql"), "utf8");
    const check = schema.match(/role\s+TEXT NOT NULL DEFAULT[\s\S]*?CHECK \(role IN \(([^)]*)\)\)/);
    expect(check, "could not find the role CHECK constraint").toBeTruthy();
    const inDb = [...check![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    const inCode = [...TENANT.match(/export const ROLES = \[([^\]]*)\]/)![1].matchAll(/"([^"]+)"/g)]
      .map((m) => m[1])
      .sort();

    expect(inCode, "the Role union and the database disagree about valid roles").toEqual(inDb);
  });
});

describe("every repository scopes itself, without relying on the database", () => {
  /**
   * Defence in depth, and the reason it is not paranoia: row-level security is
   * bypassed by any superuser or BYPASSRLS connection — a Neon admin session, a
   * migration script, a read-replica user added later. A repository trusting
   * RLS alone leaks its entire table the moment anything connects differently,
   * and nothing reports it.
   *
   * So each repo filters `sub_account_id` itself as well. The objection to that
   * is the audit's own lesson — a predicate you must remember is one that gets
   * forgotten — which is answered here rather than by leaving it out: this test
   * reads the SQL and checks.
   */
  const REPOS = join(SERVER, "repos");

  function repoFiles(): string[] {
    if (!existsSync(REPOS)) return [];
    return readdirSync(REPOS)
      .filter((n) => n.endsWith(".ts"))
      .map((n) => join(REPOS, n));
  }

  it("finds the repositories (a suite matching nothing proves nothing)", () => {
    expect(repoFiles().length).toBeGreaterThan(0);
  });

  for (const path of repoFiles()) {
    const name = path.split("/").pop()!;

    it(`${name} filters the tenant in every statement it issues`, () => {
      // Comments must go first. Doc comments here use markdown backticks around
      // column names, and those shift every subsequent backtick pairing — an
      // earlier version of this test silently skipped the main SELECT constant
      // for exactly that reason and passed while a query had no tenant filter
      // at all. A detector that quietly matches less than it claims is worse
      // than no detector.
      const src = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      // Template literals passed to q.rows/q.one, i.e. the SQL this repo runs.
      const statements = [...src.matchAll(/`([^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*)`/gi)]
        .map((m) => m[1])
        .filter((sql) => /\b(FROM|INTO|UPDATE)\s+(contacts|deals|meetings|messages|activities|calls|companies)\b/i.test(sql));

      // contacts.ts has five: the shared projection, insert, update, delete,
      // restore. A drop in this number means the extractor stopped seeing
      // statements, not that the repo got safer.
      expect(statements.length, `${name} issues no recognisable SQL`).toBeGreaterThanOrEqual(5);
      for (const sql of statements) {
        expect(
          /sub_account_id/.test(sql),
          `a statement in ${name} does not mention sub_account_id, so it would return every tenant's rows on any connection that bypasses row-level security:\n${sql.trim().slice(0, 180)}`
        ).toBe(true);
      }
    });

    it(`${name} takes the tenant from the context, never from an argument`, () => {
      const src = readFileSync(path, "utf8");
      expect(src, `${name} does not read q.ctx.subAccountId`).toMatch(/q\.ctx\.subAccountId/);
      // A caller-supplied tenant id is an authorisation bug wearing a parameter.
      expect(src, `${name} accepts a tenant id as an argument`).not.toMatch(
        /\bsubAccountId\s*:\s*string\b/
      );
    });
  }
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
