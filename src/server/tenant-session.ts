import { cookies } from "next/headers";
import { readSessionToken, SESSION_COOKIE } from "./auth";
import { logDenied } from "./log";
import { findUserById, type SafeUser } from "./repos/users";
import { withSystem, withTenant, type TenantContext, type TenantQuery } from "./tenant";

/**
 * Turning a session into a tenant.
 *
 * `requireUser()` proves who is asking. It does not say which customer's data
 * they are asking about, and until now nothing did — that gap is exactly the
 * audit's outstanding risk, dormant at one account and certain at two.
 *
 * The resolution has one genuinely dangerous step, and it is the sub-account
 * selection. Agency staff are not pinned to a single client, so the one they
 * are currently looking at has to come from somewhere the client controls —
 * and anything the client controls is something an attacker controls. So the
 * chosen sub-account is never trusted: it is checked against the database,
 * against that user's own agency, on every request. A cookie naming somebody
 * else's sub-account resolves to the user's default, not to their data.
 */

export const SUB_ACCOUNT_COOKIE = "yourcrm_sub_account";

/** The signed-in user, resolved through the new users repository. */
export async function currentUser(): Promise<SafeUser | null> {
  const store = await cookies();
  const userId = readSessionToken(store.get(SESSION_COOKIE)?.value);
  if (!userId) return null;
  return withSystem((q) => findUserById(q, userId));
}

/**
 * Which sub-account an agency user is working in.
 *
 * Separated from `requireTenant` on purpose: this is the security-critical
 * decision, and inside a function that calls `cookies()` it could only be
 * tested by standing up a Next request. A control that is awkward to test is
 * one that ends up untested, which on this project has meant one that ends up
 * broken — so the dangerous part takes its inputs as arguments.
 *
 * `requested` is attacker-controlled. It is never used without the database
 * confirming it belongs to this user's agency.
 */
export async function resolveSubAccount(
  q: Parameters<Parameters<typeof withSystem>[0]>[0],
  user: Pick<SafeUser, "agencyId" | "subAccountId">,
  requested: string | null
): Promise<string | null> {
  // A pinned user has no choice to make, so no cookie can make one for them.
  if (user.subAccountId) return user.subAccountId;

  if (requested) {
    // `agency_id = $2` is what stops a hand-written cookie from selecting
    // another agency's client. Without it, switching tenant would be a matter
    // of editing a value in the browser.
    const owned = await q.one<{ id: string }>(
      `SELECT id FROM sub_accounts
       WHERE id = $1 AND agency_id = $2 AND deleted_at IS NULL`,
      [requested, user.agencyId]
    );
    if (owned) return owned.id;
    // Either a stale cookie from a sub-account since removed, or an attempt.
    // Both fall through to the default, and the attempt leaves a trace.
    logDenied("sub-account-select", "requested sub-account is not in this agency");
  }

  const primary = await q.one<{ id: string }>(
    `SELECT id FROM sub_accounts
     WHERE agency_id = $1 AND deleted_at IS NULL
     ORDER BY is_primary DESC, created_at ASC
     LIMIT 1`,
    [user.agencyId]
  );
  return primary?.id ?? null;
}

/**
 * Resolve the tenant this request is operating in, or throw.
 *
 * Order of precedence, and the reasoning for each:
 *
 *  1. A user pinned to one sub-account gets that one, always. They have no
 *     choice to make and no cookie can give them one.
 *  2. Agency staff get the sub-account named by their cookie — but only after
 *     the database confirms it belongs to their agency and is not deleted.
 *  3. Otherwise their agency's primary sub-account, which is the workspace the
 *     agency runs its own business in.
 *
 * Throws rather than returning null, so a caller that forgets to check still
 * fails closed — the same reasoning as `requireUser`.
 */
export async function requireTenant(): Promise<TenantContext> {
  const user = await currentUser();
  if (!user) {
    logDenied("tenant-session", "no valid session");
    throw new Error("Not authenticated.");
  }

  // Pinned users: nothing to choose, nothing to validate, nothing to attack.
  if (user.subAccountId) {
    return {
      agencyId: user.agencyId,
      subAccountId: user.subAccountId,
      userId: user.id,
      role: user.role,
    };
  }

  const store = await cookies();
  const requested = store.get(SUB_ACCOUNT_COOKIE)?.value ?? null;
  const subAccountId = await withSystem((q) => resolveSubAccount(q, user, requested));

  if (!subAccountId) {
    // An agency with no sub-accounts cannot be worked in. Loud, because it
    // means something went wrong during signup rather than during this request.
    logDenied("tenant-session", "agency has no usable sub-account");
    throw new Error("No workspace is available for this account.");
  }

  return { agencyId: user.agencyId, subAccountId, userId: user.id, role: user.role };
}

/**
 * Run `fn` in the current request's tenant.
 *
 * The intended entry point for every server action and every page: it resolves
 * identity, resolves tenant, and hands over a scoped querier in one step, so
 * there is no arrangement of calls that reaches the database having done only
 * half of that.
 */
export async function withCurrentTenant<T>(fn: (q: TenantQuery) => Promise<T>): Promise<T> {
  const ctx = await requireTenant();
  return withTenant(ctx, fn);
}

/**
 * The sub-accounts this user may switch between.
 *
 * Empty for a pinned user — not because they have one, but because they have no
 * choice, and a switcher offering a single option is noise.
 */
export async function switchableSubAccounts(): Promise<{ id: string; name: string }[]> {
  const user = await currentUser();
  if (!user || user.subAccountId) return [];
  return withSystem((q) =>
    q.rows<{ id: string; name: string }>(
      `SELECT id, name FROM sub_accounts
       WHERE agency_id = $1 AND deleted_at IS NULL
       ORDER BY is_primary DESC, name ASC`,
      [user.agencyId]
    )
  );
}
