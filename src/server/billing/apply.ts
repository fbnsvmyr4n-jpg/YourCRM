import { logWrite } from "../log";
import type { SystemQuery } from "../tenant";
import type { SubscriptionState } from "./subscription";

/**
 * Writing a subscription's state onto an agency.
 *
 * Two hazards, both inherent to webhooks rather than to this code:
 *
 *  1. **Duplicates.** Stripe delivers at least once and retries anything that
 *     does not return 2xx. The same event will arrive twice.
 *  2. **Order.** Events are not ordered. A `subscription.updated` delayed by a
 *     retry can land *after* the `subscription.deleted` that followed it, and
 *     applying it would resurrect a cancelled subscription — an account that
 *     keeps working after the customer cancelled, billing nobody.
 *
 * Both are handled by comparing Stripe's own `created` time against
 * `agencies.billing_synced_at`, and by recording every event id.
 */

export type ApplyResult =
  | { applied: true; agencyId: string }
  | { applied: false; reason: "duplicate" | "stale" | "unknown_agency" };

/**
 * Has this event already been handled?
 *
 * Recorded before the work, not after: two deliveries can be in flight at once,
 * and a check-then-insert leaves a window where both pass. The primary key is
 * what actually rejects the second, so the insert IS the check.
 */
export async function claimEvent(
  q: SystemQuery,
  event: { id: string; type: string; created: number },
  agencyId: string | null
): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `INSERT INTO stripe_events (id, type, created_at, agency_id)
     VALUES ($1, $2, to_timestamp($3), $4)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [event.id, event.type, event.created, agencyId]
  );
  return row !== null;
}

/** The agency a Stripe customer belongs to, if we know it. */
export async function agencyForCustomer(
  q: SystemQuery,
  customerId: string | null
): Promise<string | null> {
  if (!customerId) return null;
  const row = await q.one<{ id: string }>(
    `SELECT id FROM agencies WHERE stripe_customer_id = $1 AND deleted_at IS NULL`,
    [customerId]
  );
  return row?.id ?? null;
}

/**
 * Apply a subscription's state to an agency.
 *
 * `eventCreated` is Stripe's timestamp for the event, in seconds. The UPDATE
 * refuses to run when the agency was last synced from a *later* event, which is
 * what makes out-of-order delivery harmless. The comparison is in SQL rather
 * than in a read-then-write, so two deliveries racing cannot both decide they
 * are newest.
 */
export async function applySubscription(
  q: SystemQuery,
  agencyId: string,
  state: SubscriptionState,
  eventCreated: number
): Promise<ApplyResult> {
  const row = await q.one<{ id: string }>(
    `UPDATE agencies SET
       plan = $2,
       plan_status = $3,
       trial_ends_at = $4,
       stripe_customer_id = COALESCE($5, stripe_customer_id),
       stripe_subscription_id = COALESCE($6, stripe_subscription_id),
       billing_synced_at = to_timestamp($7)
     WHERE id = $1
       AND deleted_at IS NULL
       -- Never move backwards in time. A NULL means nothing has synced yet.
       AND (billing_synced_at IS NULL OR billing_synced_at <= to_timestamp($7))
     RETURNING id`,
    [
      agencyId,
      state.plan,
      state.status,
      state.trialEndsAt,
      state.stripeCustomerId,
      state.stripeSubscriptionId,
      eventCreated,
    ]
  );

  if (!row) return { applied: false, reason: "stale" };

  // Deliberately not logging the customer or subscription id: the log is read
  // by people who have no reason to hold billing identifiers.
  logWrite("update", "agency_billing", {
    id: agencyId,
    detail: `${state.plan} / ${state.status}`,
  });
  return { applied: true, agencyId };
}

/**
 * Attach a Stripe customer to an agency, before any subscription exists.
 *
 * Written at checkout so the webhook that follows can find the agency by its
 * customer id. Without it the first `customer.subscription.created` arrives for
 * a customer nobody recognises, and the payment succeeds while the account
 * stays on its trial.
 */
export async function linkCustomer(
  q: SystemQuery,
  agencyId: string,
  customerId: string
): Promise<void> {
  await q.rows(
    `UPDATE agencies SET stripe_customer_id = $2
     WHERE id = $1 AND deleted_at IS NULL AND stripe_customer_id IS NULL`,
    [agencyId, customerId]
  );
}
