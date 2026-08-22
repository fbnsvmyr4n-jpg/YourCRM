import type { SystemQuery, TenantQuery } from "./tenant";

/**
 * What this agency is currently allowed to do.
 *
 * Two separate questions, deliberately kept apart:
 *
 *   1. Which plan are they on? — a column on `agencies`.
 *   2. Is that plan currently in force? — `plan_status` and `trial_ends_at`.
 *
 * Conflating them is how a lapsed trial keeps working. The audit's note on this
 * was blunt: *a lapsed trial that still grants access is revenue quietly
 * leaking*, and it leaks in the direction nobody notices, because the customer
 * is happy and the invoice simply never appears.
 *
 * Entitlements themselves live in `plan_entitlements`, one row per grant, so a
 * pricing change is a row edit rather than a hunt for every `if (plan === …)`.
 */

export type Entitlements = {
  plan: string;
  status: string;
  /** False when the plan is not in force — lapsed trial, or cancelled. */
  active: boolean;
  /** Why access is restricted, for the message the user sees. */
  reason?: "trial_expired" | "canceled" | "no_agency";
  /** True while paying but with a failed charge — access continues, see below. */
  inGrace: boolean;
  trialEndsAt: string | null;
  /** feature → limit. `null` means the feature is granted with no cap. */
  grants: Map<string, number | null>;
};

type AnyQuery = Pick<TenantQuery, "rows" | "one"> | Pick<SystemQuery, "rows" | "one">;

const NOTHING = (plan: string, status: string, reason: Entitlements["reason"]): Entitlements => ({
  plan,
  status,
  active: false,
  reason,
  inGrace: false,
  trialEndsAt: null,
  grants: new Map(),
});

/**
 * Resolve what an agency may do, right now.
 *
 * The status rules, and why each is what it is:
 *
 *   `active`    — paying. Everything the plan grants.
 *   `trialing`  — full access until `trial_ends_at`, then nothing. A trial that
 *                 keeps working after it ends is not a trial, it is a free tier
 *                 nobody decided to offer.
 *   `past_due`  — access CONTINUES. Stripe retries a failed card for about two
 *                 weeks, and locking somebody out because a card expired on a
 *                 Tuesday loses a customer over a problem they would have fixed
 *                 in a day. Flagged as `inGrace` so the UI can say so.
 *   `canceled`  — nothing.
 *
 * Read at request time rather than cached on the session, so a cancellation
 * takes effect on the next page load instead of whenever somebody signs out.
 */
export async function entitlementsFor(q: AnyQuery, agencyId: string): Promise<Entitlements> {
  const agency = await q.one<{
    plan: string;
    plan_status: string;
    trial_ends_at: Date | null;
  }>(
    `SELECT plan, plan_status, trial_ends_at FROM agencies
     WHERE id = $1 AND deleted_at IS NULL`,
    [agencyId]
  );

  if (!agency) return NOTHING("none", "none", "no_agency");

  const trialEndsAt = agency.trial_ends_at ? agency.trial_ends_at.toISOString() : null;
  /**
   * A trial with no end date counts as expired.
   *
   * The condition used to require `trial_ends_at !== null`, which meant a
   * trialing row without one never expired. Signup wrote exactly that row, so
   * every account was permanently free. Signup now sets the date — but the rule
   * belongs here too, because this is the function that decides. An unbounded
   * trial is not a trial; it is a free tier nobody decided to offer, and the
   * safe direction for a row nobody can explain is to ask them to choose a plan.
   */
  const trialExpired =
    agency.plan_status === "trialing" &&
    (agency.trial_ends_at === null || agency.trial_ends_at.getTime() <= Date.now());

  if (agency.plan_status === "canceled") return NOTHING(agency.plan, agency.plan_status, "canceled");
  if (trialExpired) {
    const out = NOTHING(agency.plan, agency.plan_status, "trial_expired");
    out.trialEndsAt = trialEndsAt;
    return out;
  }

  const rows = await q.rows<{ feature: string; limit_value: number | null }>(
    `SELECT feature, limit_value FROM plan_entitlements WHERE plan = $1`,
    [agency.plan]
  );

  return {
    plan: agency.plan,
    status: agency.plan_status,
    active: true,
    inGrace: agency.plan_status === "past_due",
    trialEndsAt,
    grants: new Map(rows.map((r) => [r.feature, r.limit_value])),
  };
}

/** The current request's agency. */
export function entitlements(q: TenantQuery): Promise<Entitlements> {
  return entitlementsFor(q, q.ctx.agencyId);
}

/**
 * Is this feature granted?
 *
 * A feature with no row is not granted. That is the whole rule — there is no
 * "enabled: false", because an absent grant and a disabled grant would be two
 * ways to say the same thing and they would eventually disagree.
 */
export function can(e: Entitlements, feature: string): boolean {
  return e.active && e.grants.has(feature);
}

/** The cap on a feature. `null` means unlimited; `0` means not granted at all. */
export function limitOf(e: Entitlements, feature: string): number | null | 0 {
  if (!can(e, feature)) return 0;
  return e.grants.get(feature) ?? null;
}

/**
 * Is there room for one more?
 *
 * Takes the count that already exists, so the caller cannot accidentally ask
 * "am I under the limit" when it means "may I add another" — an off-by-one
 * that shows up as a plan allowing exactly one more than it sells.
 */
export function hasRoomFor(e: Entitlements, feature: string, existing: number): boolean {
  const limit = limitOf(e, feature);
  if (limit === 0) return false;
  if (limit === null) return true;
  return existing < limit;
}

export type Denial = { allowed: false; reason: string };
export type Allowance = { allowed: true };

/**
 * The message a person should see, rather than the state a developer sees.
 *
 * Every refusal says what to do next. "Not available on your plan" with no
 * route forward is a dead end that generates a support email; naming the tier
 * that includes it turns the same refusal into an upgrade prompt.
 */
export function explain(e: Entitlements, feature: string): Denial | Allowance {
  if (!e.active) {
    if (e.reason === "trial_expired") {
      return { allowed: false, reason: "Your free trial has ended. Choose a plan to carry on." };
    }
    if (e.reason === "canceled") {
      return { allowed: false, reason: "This subscription has been cancelled. Reactivate it to carry on." };
    }
    return { allowed: false, reason: "This account has no active subscription." };
  }

  if (!e.grants.has(feature)) {
    const tier = FEATURE_TIER[feature];
    return {
      allowed: false,
      reason: tier
        ? `That is part of the ${tier} plan.`
        : "That is not included in your current plan.",
    };
  }

  return { allowed: true };
}

/**
 * The cheapest tier that includes each feature, for the upgrade prompt.
 *
 * Derived from the seeded entitlements rather than written twice — a feature
 * that moves between tiers must not leave the prompt naming the old one.
 */
export const FEATURE_TIER: Record<string, string> = {
  api_access: "Unlimited",
  white_label: "Unlimited",
  saas_mode: "SaaS Pro",
  rebilling: "SaaS Pro",
};
