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

export const ROLES = ["agency_owner", "agency_admin", "agency_staff", "sub_account_user"] as const;
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
