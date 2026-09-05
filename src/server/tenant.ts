import type { PoolClient, QueryResultRow } from "pg";
import { getPool } from "./db";
import { logDenied } from "./log";

/**
 * Tenant context — the thing every query must run inside.
 *
 * The schema declares row-level policies keyed on `app.sub_account_id`. Those
 * policies are inert until something sets that variable, and this module is the
 * only thing that sets it. So the rule the audit kept re-learning — that a
 * guard a developer has to *remember* is a guard that eventually gets forgotten
 * — is answered structurally here: there is no exported way to reach the
 * database except through `withTenant`, and the querier it hands you cannot be
 * constructed anywhere else.
 *
 * Three levels, per the product direction:
 *   agency        — the paying customer
 *   sub_account   — that agency's own client
 *   user          — a person inside either
 */

/**
 * Permission tier, mirroring the CHECK constraint on `users.role`. The two are
 * kept identical by a test — an enum with two sources of truth is the drift the
 * project's rules exist to prevent, and this pair had already diverged once.
 *
 * **The order is load-bearing**, not alphabetical and not historical: most
 * powerful first. `assignable` on the Team screen is `ROLES.filter(...)` and
 * takes its default from the LAST entry, so the least privileged role has to be
 * last or a new colleague would default to the most powerful one somebody could
 * grant. Ranked by what the matrix grants: owner (3 capabilities), admin (2),
 * finance (1), member (0).
 *
 * A user's *level* is not encoded here: agency staff have a NULL
 * `sub_account_id`, sub-account staff have one. Level is structure, role is
 * permission, and conflating them was what produced four overlapping values.
 */
export const ROLES = ["owner", "admin", "finance", "member"] as const;
export type Role = (typeof ROLES)[number];

export type TenantContext = {
  agencyId: string;
  /** The sub-account whose data this request may touch. Never optional. */
  subAccountId: string;
  userId: string;
  role: Role;
};

/**
 * A querier bound to one tenant, for one transaction.
 *
 * The private brand is the enforcement: nothing outside this file can produce a
 * value of this type, so a repository function that wants to run SQL has to be
 * handed one, which means someone above it had to establish a tenant. A
 * repository cannot quietly reach for a connection of its own.
 */
declare const tenantBrand: unique symbol;

export interface TenantQuery {
  readonly [tenantBrand]: true;
  readonly ctx: TenantContext;
  /** Run a query already constrained to this tenant by row-level security. */
  rows<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run a query expected to return exactly one row; `null` if it returns none. */
  one<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T | null>;
}

function querier(client: PoolClient, ctx: TenantContext): TenantQuery {
  const q = {
    ctx,
    async rows<T extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const { rows } = await client.query<T>(sql, params as unknown[]);
      return rows;
    },
    async one<T extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<T | null> {
      const { rows } = await client.query<T>(sql, params as unknown[]);
      return rows[0] ?? null;
    },
  };
  return q as TenantQuery;
}

/**
 * Run `fn` inside a transaction scoped to one tenant.
 *
 * `SET LOCAL` — not `SET` — is load-bearing. The pool hands the same physical
 * connection to unrelated requests, so a session-level setting would survive
 * COMMIT and the next request to borrow that connection would read the previous
 * tenant's id. That is the exact cross-tenant leak the policies exist to
 * prevent, reintroduced by the mechanism meant to enforce them. `LOCAL` binds
 * the value to the transaction, so it is gone the moment this function returns
 * by any path, including a throw.
 *
 * `set_config($1, $2, true)` rather than string interpolation: `SET LOCAL` does
 * not accept bind parameters, and interpolating an id into SQL is how injection
 * happens. `set_config` is the parameterised form of the same statement.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (q: TenantQuery) => Promise<T>
): Promise<T> {
  if (!ctx.subAccountId || !ctx.agencyId) {
    // Fail closed. An empty id would make `current_setting` return '' and match
    // nothing, which looks like an empty account rather than a broken request —
    // a silent wrong answer instead of a loud failure.
    logDenied("tenant", "missing tenant identity");
    throw new Error("No tenant context.");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.sub_account_id', $1, true)", [ctx.subAccountId]);
    await client.query("SELECT set_config('app.agency_id', $1, true)", [ctx.agencyId]);
    const result = await fn(querier(client, ctx));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A querier for work that happens BEFORE anyone is signed in.
 *
 * Rate limiting a login and issuing a password reset both run for someone whose
 * account has not been identified yet — that is the entire point of them — so
 * there is no tenant to scope them to and `withTenant` cannot serve them. The
 * honest options were an escape hatch or letting those modules reach for the
 * pool themselves; the second would put a hole in the rule that nothing outside
 * this file opens a connection, and would be invisible in review.
 *
 * So the hatch exists, is named for what it is, and is deliberately awkward:
 * a separate brand, so a repository written for tenant data cannot silently
 * accept one. The tables it may touch are listed here and enforced by a test —
 * none of them holds customer records; a row is a hash or a counter.
 */
declare const systemBrand: unique symbol;

/** The only tables reachable without a tenant. Enforced by `tenant-context.test.ts`. */
export const SYSTEM_TABLES = ["users", "password_resets", "login_attempts", "agencies", "sub_accounts"] as const;

export interface SystemQuery {
  readonly [systemBrand]: true;
  rows<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  one<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T | null>;
}

/**
 * Run `fn` with no tenant set.
 *
 * Still a transaction, and still the pool — the only thing missing is
 * `app.sub_account_id`, which means every row-level policy matches nothing.
 * That is the safety property: if this is ever pointed at a CRM table by
 * mistake, it returns empty rather than everything.
 */
export async function withSystem<T>(fn: (q: SystemQuery) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const q = {
      async rows<R extends QueryResultRow>(sql: string, params: readonly unknown[] = []) {
        const { rows } = await client.query<R>(sql, params as unknown[]);
        return rows;
      },
      async one<R extends QueryResultRow>(sql: string, params: readonly unknown[] = []) {
        const { rows } = await client.query<R>(sql, params as unknown[]);
        return rows[0] ?? null;
      },
    } as SystemQuery;
    const result = await fn(q);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

