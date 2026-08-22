import { logDenied, logWrite } from "../log";
import type { SystemQuery } from "../tenant";
import { PLAN_INFO, priceIdFor, TRIAL_DAYS, type Plan } from "./plans";
import { appUrl, stripe } from "./stripe";

/**
 * Sending somebody to Stripe to pay, and back again afterwards.
 *
 * Nothing here writes a plan. The redirect from Stripe is a *hint* that a
 * payment happened — it can be forged, replayed, or simply never followed
 * because the customer closed the tab on the confirmation page. The webhook is
 * what changes an account, and it arrives whether or not anyone comes back.
 */

export type CheckoutResult = { ok: true; url: string } | { ok: false; error: string };

type AgencyBilling = {
  id: string;
  name: string;
  plan: Plan;
  plan_status: string;
  trial_ends_at: Date | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

export async function agencyBilling(
  q: SystemQuery,
  agencyId: string
): Promise<AgencyBilling | null> {
  return q.one<AgencyBilling>(
    `SELECT id, name, plan, plan_status, trial_ends_at,
            stripe_customer_id, stripe_subscription_id
     FROM agencies WHERE id = $1 AND deleted_at IS NULL`,
    [agencyId]
  );
}

/**
 * The parameters for a Checkout session.
 *
 * Separated from the call that sends them for the same reason `readSubscription`
 * is separate: three of the fields here decide whether a payment ever reaches
 * the right account, and none of them could be tested while they were built
 * inline in a function that talks to Stripe. Removing any of the three left the
 * whole suite green while breaking billing in a way that is invisible until a
 * customer says they paid and nothing happened.
 */
export function checkoutParams(input: {
  agencyId: string;
  price: string;
  ownerEmail: string;
  existingCustomerId: string | null;
  trialEnd: number | null;
  returnTo: string;
}) {
  return {
    mode: "subscription" as const,
    line_items: [{ price: input.price, quantity: 1 }],

    // OUR id, not anything the browser supplied. It is what the webhook uses
    // to attach the resulting Stripe customer to this account — without it the
    // payment succeeds and the account stays on its trial forever.
    client_reference_id: input.agencyId,

    // Reuse the existing customer so a second subscription does not create a
    // duplicate. Two Stripe customers for one agency means the webhook resolves
    // to whichever was linked first, and the new payment appears to do nothing.
    ...(input.existingCustomerId
      ? { customer: input.existingCustomerId }
      : { customer_email: input.ownerEmail }),

    subscription_data: {
      // Somebody subscribing on day 3 of a 14-day trial keeps the other eleven.
      // Without this they are charged immediately, losing days they were
      // promised — a small amount of money and a large amount of goodwill.
      ...(input.trialEnd ? { trial_end: input.trialEnd } : {}),
      metadata: { agency_id: input.agencyId },
    },

    success_url: `${input.returnTo}/settings?billing=done`,
    cancel_url: `${input.returnTo}/settings?billing=cancelled`,
    allow_promotion_codes: true,
  };
}

/** A Stripe Checkout session for one plan. */
export async function startCheckout(
  q: SystemQuery,
  agencyId: string,
  plan: Plan,
  ownerEmail: string
): Promise<CheckoutResult> {
  const client = stripe();
  if (!client) return { ok: false, error: "Billing is not configured on this deployment." };

  const price = priceIdFor(plan);
  if (!price) {
    // A missing price id is a deployment fault, not a customer one. Named in
    // the log; the customer is told only that the plan is unavailable.
    logDenied("checkout", `no Stripe price configured for ${plan}`);
    return { ok: false, error: `The ${PLAN_INFO[plan].name} plan is not available right now.` };
  }

  const agency = await agencyBilling(q, agencyId);
  if (!agency) return { ok: false, error: "This account could not be found." };

  const remainingTrial = trialSecondsLeft(agency.trial_ends_at);

  try {
    const session = await client.checkout.sessions.create(
      checkoutParams({
        agencyId,
        price,
        ownerEmail,
        existingCustomerId: agency.stripe_customer_id,
        trialEnd: remainingTrial,
        returnTo: appUrl(),
      })
    );

    if (!session.url) return { ok: false, error: "Stripe did not return a checkout page." };

    logWrite("create", "checkout_session", { id: agencyId, detail: plan });
    return { ok: true, url: session.url };
  } catch (err) {
    // Stripe's own message can name a price or an account. The customer gets
    // something they can act on; the detail goes to the log.
    logDenied("checkout", `Stripe refused the session: ${(err as Error).message}`);
    return { ok: false, error: "Could not start checkout. Please try again." };
  }
}

/**
 * Whatever is left of the trial, as a Stripe timestamp — or null.
 *
 * Stripe rejects a `trial_end` less than 48 hours away, so a trial with under
 * two days on it is dropped rather than sent. Losing the last day of a trial is
 * a smaller harm than a checkout page that will not open.
 */
export function trialSecondsLeft(trialEndsAt: Date | null, now: Date = new Date()): number | null {
  if (!trialEndsAt) return null;
  const seconds = Math.floor(trialEndsAt.getTime() / 1000);
  const minimum = Math.floor(now.getTime() / 1000) + 48 * 3600;
  return seconds > minimum ? seconds : null;
}

/**
 * A link into Stripe's own billing portal.
 *
 * Card details, invoices, cancellation and plan changes all live there. Building
 * any of it here would mean handling card data, which is a compliance burden
 * this product has no reason to take on.
 */
export async function billingPortal(
  q: SystemQuery,
  agencyId: string
): Promise<CheckoutResult> {
  const client = stripe();
  if (!client) return { ok: false, error: "Billing is not configured on this deployment." };

  const agency = await agencyBilling(q, agencyId);
  if (!agency?.stripe_customer_id) {
    return { ok: false, error: "There is no subscription to manage yet." };
  }

  try {
    const session = await client.billingPortal.sessions.create({
      customer: agency.stripe_customer_id,
      return_url: `${appUrl()}/settings`,
    });
    return { ok: true, url: session.url };
  } catch (err) {
    logDenied("billing-portal", `Stripe refused the portal session: ${(err as Error).message}`);
    return { ok: false, error: "Could not open the billing portal. Please try again." };
  }
}

/** Whole days left on a trial, for display. Never negative. */
export function trialDaysLeft(trialEndsAt: Date | string | null, now: Date = new Date()): number {
  if (!trialEndsAt) return 0;
  const end = typeof trialEndsAt === "string" ? new Date(trialEndsAt) : trialEndsAt;
  const ms = end.getTime() - now.getTime();
  if (ms <= 0) return 0;
  // Rounded up: with six hours left, "1 day" is honest and "0 days" reads as
  // already over.
  return Math.min(TRIAL_DAYS, Math.ceil(ms / 86_400_000));
}
