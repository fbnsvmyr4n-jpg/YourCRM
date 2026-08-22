import { isPlan, planForPriceId, type Plan } from "./plans";

/**
 * Turning a Stripe subscription into the three columns this app actually reads.
 *
 * Kept as a pure function, taking a plain object rather than a Stripe client,
 * for one reason: this is the decision that determines whether a paying
 * customer keeps access, and it has to be testable against every status Stripe
 * can send without a network, a key, or a fixture server.
 *
 * Stripe has eight subscription statuses; this product has four. Collapsing
 * them is where money is either lost or a customer is wrongly locked out, so
 * each mapping is written down with its reason.
 */

/** What the `agencies` billing columns should become. */
export type SubscriptionState = {
  plan: Plan;
  status: "trialing" | "active" | "past_due" | "canceled";
  trialEndsAt: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

/** The shape read off a Stripe subscription — only the fields that matter. */
export type StripeSubscriptionLike = {
  id: string;
  status: string;
  customer: string | { id: string } | null;
  trial_end?: number | null;
  cancel_at_period_end?: boolean;
  items?: { data?: Array<{ price?: { id?: string } | null }> };
};

/**
 * Stripe status → ours.
 *
 *   `trialing`            → trialing. Access, bounded by `trial_end`.
 *   `active`              → active.
 *   `past_due`            → past_due. Access CONTINUES: Stripe retries a failed
 *                           card for about two weeks, and locking somebody out
 *                           because a card expired on a Tuesday loses a
 *                           customer over a problem they would have fixed in a
 *                           day.
 *   `unpaid`              → canceled. This is where Stripe lands once the
 *                           retries are exhausted. It is the end of the dunning
 *                           road, not a softer `past_due`, and treating it as
 *                           one would give indefinite free access to somebody
 *                           whose card has definitively failed.
 *   `canceled`            → canceled.
 *   `incomplete`          → canceled. The first payment never succeeded, so
 *                           nothing was ever bought.
 *   `incomplete_expired`  → canceled.
 *   `paused`              → canceled. Stripe pauses collection; access should
 *                           pause with it rather than run on unbilled.
 *
 * An unrecognised status maps to `canceled`. Stripe adds statuses over time,
 * and the safe direction for something nobody has decided about is the one that
 * shows an upgrade prompt rather than the one that hands out the product. It is
 * visible immediately and costs a support message; the other direction is
 * invisible and costs revenue.
 */
const STATUS: Record<string, SubscriptionState["status"]> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "canceled",
  canceled: "canceled",
  incomplete: "canceled",
  incomplete_expired: "canceled",
  paused: "canceled",
};

export function mapStatus(stripeStatus: string): SubscriptionState["status"] {
  return STATUS[stripeStatus] ?? "canceled";
}

/**
 * Read a subscription into the state to store.
 *
 * `fallbackPlan` is used when the price id matches nothing this deployment
 * knows — a catalogue mismatch between Stripe and this environment. Keeping the
 * plan the agency already has is the least wrong answer available: guessing the
 * cheapest tier would downgrade somebody who is paying for more, and refusing
 * outright would lock out a customer over a configuration error that is not
 * theirs.
 */
export function readSubscription(
  sub: StripeSubscriptionLike,
  fallbackPlan: Plan
): SubscriptionState {
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  const mapped = planForPriceId(priceId);

  return {
    plan: mapped ?? (isPlan(fallbackPlan) ? fallbackPlan : "starter"),
    status: mapStatus(sub.status),
    // Stripe sends seconds. Multiplying by 1000 is easy to forget and produces
    // a date in 1970, which reads as a trial that ended before it began.
    trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    stripeCustomerId: typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null),
    stripeSubscriptionId: sub.id,
  };
}
