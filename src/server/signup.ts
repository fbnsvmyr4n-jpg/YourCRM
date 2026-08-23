import { trialEndsAt } from "./billing/plans";
import { attributeSignup } from "./referral-rewards";
import { createUser, type SafeUser } from "./repos/users";
import { withSystem, type SystemQuery } from "./tenant";

/**
 * Signing up creates a tenant, not just a user.
 *
 * Under the old single-workspace model an account was one row in `users` and
 * everybody shared the same data. This product sells sub-accounts to agencies,
 * so the first thing a new customer needs is somewhere isolated to put their
 * records — an agency, its primary sub-account, and an owner inside it.
 *
 * All three in one transaction. A half-created tenant is a person who can sign
 * in and has nowhere to work, which fails at the next request with an error
 * about workspaces that says nothing about what went wrong.
 */

export type SignUpResult = { user?: SafeUser; agencyId?: string; error?: string };

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 24) || "account"
  );
}

export async function signUpNewTenant(
  q: SystemQuery,
  input: { name: string; email: string; password: string; referralCode?: string | null }
): Promise<SignUpResult> {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const agencyId = `ag-${slug(input.name)}-${suffix}`;
  const subAccountId = `sa-${slug(input.name)}-${suffix}`;

  /**
   * The trial is given an end date here, at the moment the account is created.
   *
   * It used to be left NULL, and `entitlementsFor` only expires a trial that
   * has an end — so every account signed up was on a free trial that never
   * finished. Nothing errored, nobody complained, and no invoice was ever due.
   * That is the "revenue quietly leaking" case, and it was already shipping.
   */
  await q.rows(
    `INSERT INTO agencies (id, name, plan, plan_status, trial_ends_at)
     VALUES ($1, $2, 'starter', 'trialing', $3)`,
    [agencyId, `${input.name}'s account`, trialEndsAt()]
  );

  // The customer's own workspace is sub-account #1, marked primary. Their own
  // business is not a special case — it is the first of the accounts they may
  // go on to manage, so "view across my clients" stays a query.
  await q.rows(
    `INSERT INTO sub_accounts (id, agency_id, name, is_primary) VALUES ($1, $2, $3, TRUE)`,
    [subAccountId, agencyId, "Main workspace"]
  );

  const { user, error } = await createUser(q, {
    agencyId,
    email: input.email,
    password: input.password,
    name: input.name,
    // The owner of a brand-new agency. Not pinned to the sub-account: an
    // owner works across every client they later add, and pinning them here
    // would lock them out of their own second workspace.
    role: "owner",
    subAccountId: null,
  });

  // The email uniqueness index is what actually rejects a duplicate, and it
  // fires inside this transaction — so the agency and sub-account written
  // above roll back with it rather than being left orphaned.
  if (error || !user) return { error: error ?? "The account could not be created." };

  /**
   * Who sent them, if anybody.
   *
   * Recorded here and never afterwards: attribution belongs to the moment of
   * signup, and letting it be set later would mean an agency could claim a
   * customer somebody else had already brought in. A code that matches nothing
   * is ignored rather than refused — a mistyped code should not stop somebody
   * creating an account.
   */
  if (input.referralCode?.trim()) {
    await attributeSignup(q, agencyId, input.referralCode);
  }

  return { user, agencyId };
}

/** Convenience wrapper: sign-up happens before any tenant exists. */
export function signUp(input: {
  name: string;
  email: string;
  password: string;
  referralCode?: string | null;
}) {
  return withSystem((q) => signUpNewTenant(q, input));
}
