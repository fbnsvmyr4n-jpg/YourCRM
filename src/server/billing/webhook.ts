import { logDenied, logWrite } from "../log";
import type { SystemQuery } from "../tenant";
import { agencyForCustomer, applySubscription, claimEvent, linkCustomer } from "./apply";
import { earnFromPayment } from "../referral-rewards";
import { isPlan, type Plan } from "./plans";
import { readSubscription, type StripeSubscriptionLike } from "./subscription";

/**
 * What a Stripe event means for an agency.
 *
 * Separated from the route handler on purpose. The route's job is signature
 * verification and reading a raw body — things that need a real request. This
 * is the decision-making, which needs a database and nothing else, so every
 * event type can be tested against real rows without a server or a Stripe key.
 *
 * The events handled, and why each:
 *
 *   `checkout.session.completed`      — the customer exists now, and must be
 *                                       linked to the agency before any
 *                                       subscription event can find it.
 *   `customer.subscription.created`   — a plan has started.
 *   `customer.subscription.updated`   — upgrade, downgrade, trial ending,
 *                                       payment recovered, cancellation
 *                                       scheduled. Most state changes are this.
 *   `customer.subscription.deleted`   — it is over.
 *
 * `invoice.payment_failed` is deliberately NOT handled: it always arrives with
 * a subscription status change, and two sources deciding the same column is how
 * an account ends up `past_due` after the payment has already been recovered.
 *
 * `invoice.paid` IS handled, but only to accrue referral credit. It writes to
 * the credit ledger and never to `plan_status`, so it cannot argue with the
 * subscription events about what state an account is in.
 */

export type HandledEvent = {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
};

export type WebhookOutcome =
  | { ok: true; action: "applied" | "linked"; agencyId: string }
  | { ok: true; action: "ignored"; reason: string }
  | { ok: false; reason: string };

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

export async function handleStripeEvent(
  q: SystemQuery,
  event: HandledEvent
): Promise<WebhookOutcome> {
  const object = event.data.object;

  if (event.type === "checkout.session.completed") {
    // The agency id travels in the session's metadata because at this point
    // there is nothing else connecting a Stripe customer to an account. It is
    // OUR value, set when the session was created — not user input — but it is
    // still checked against a real row before it is used.
    const agencyId = typeof object.client_reference_id === "string" ? object.client_reference_id : null;
    const customerId =
      typeof object.customer === "string"
        ? object.customer
        : ((object.customer as { id?: string } | null)?.id ?? null);

    if (!agencyId || !customerId) {
      return { ok: false, reason: "checkout session carried no agency or customer" };
    }

    if (!(await claimEvent(q, event, agencyId))) {
      return { ok: true, action: "ignored", reason: "duplicate" };
    }

    await linkCustomer(q, agencyId, customerId);
    logWrite("update", "agency_billing", { id: agencyId, detail: "customer linked" });
    return { ok: true, action: "linked", agencyId };
  }

  if (event.type === "invoice.paid") {
    /**
     * The one invoice event handled, and only for referral credit.
     *
     * Plan status is decided by the subscription events alone — two sources
     * writing the same column is how an account ends up `past_due` after the
     * payment has already been recovered. This touches nothing but the credit
     * ledger, which is why it can live alongside them safely.
     */
    const invoiceId = typeof object.id === "string" ? object.id : null;
    const paid = typeof object.amount_paid === "number" ? object.amount_paid : 0;
    const customerId =
      typeof object.customer === "string"
        ? object.customer
        : ((object.customer as { id?: string } | null)?.id ?? null);

    const payerId = await agencyForCustomer(q, customerId);
    if (!payerId || !invoiceId) {
      await claimEvent(q, event, null);
      return { ok: true, action: "ignored", reason: "invoice for an unknown customer" };
    }

    if (!(await claimEvent(q, event, payerId))) {
      return { ok: true, action: "ignored", reason: "duplicate" };
    }

    const { earned, referrerId } = await earnFromPayment(q, payerId, paid, invoiceId);
    if (earned > 0 && referrerId) {
      return { ok: true, action: "applied", agencyId: referrerId };
    }
    return { ok: true, action: "ignored", reason: "no referrer to credit" };
  }

  if (!SUBSCRIPTION_EVENTS.has(event.type)) {
    // Recorded even though nothing is done with it, so a redelivery of an event
    // type this app later starts handling cannot be applied twice.
    await claimEvent(q, event, null);
    return { ok: true, action: "ignored", reason: `unhandled type ${event.type}` };
  }

  const sub = object as unknown as StripeSubscriptionLike;
  const customerId = typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null);
  const agencyId = await agencyForCustomer(q, customerId);

  if (!agencyId) {
    // A subscription for a customer this deployment has never seen. Almost
    // always the test-mode endpoint receiving live traffic or the reverse.
    // Claimed so it is not retried forever, and logged loudly, because the
    // alternative is a paying customer whose account never activates.
    await claimEvent(q, event, null);
    logDenied("stripe-webhook", `subscription for an unknown customer (${event.type})`);
    return { ok: true, action: "ignored", reason: "unknown_customer" };
  }

  if (!(await claimEvent(q, event, agencyId))) {
    return { ok: true, action: "ignored", reason: "duplicate" };
  }

  const current = await q.one<{ plan: string }>(`SELECT plan FROM agencies WHERE id = $1`, [
    agencyId,
  ]);
  const fallback: Plan = current && isPlan(current.plan) ? current.plan : "starter";

  const state =
    event.type === "customer.subscription.deleted"
      ? // Deletion is final regardless of what the object's status field says.
        // Stripe sends the subscription as it was, and reading its status here
        // has produced `active` on a deleted subscription.
        { ...readSubscription(sub, fallback), status: "canceled" as const, trialEndsAt: null }
      : readSubscription(sub, fallback);

  const result = await applySubscription(q, agencyId, state, event.created);
  if (!result.applied) {
    return { ok: true, action: "ignored", reason: result.reason };
  }

  return { ok: true, action: "applied", agencyId };
}
