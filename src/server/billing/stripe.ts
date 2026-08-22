import Stripe from "stripe";

/**
 * The Stripe client, and the question of whether there is one.
 *
 * Billing is configured by environment variables that will not be present on
 * every deployment — a local checkout, a preview branch, a fork. The choice
 * that matters is what happens then, and the answer is: the app says billing is
 * not configured. It does not pretend a subscription exists, and it does not
 * crash a page that merely mentions the plan.
 *
 * The alternative — a client constructed with an empty key — fails at the point
 * of use with a Stripe authentication error, which surfaces to a customer as a
 * broken upgrade button rather than as a deployment that is missing a setting.
 */

let client: Stripe | null = null;

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

/** The webhook endpoint's signing secret, without which no event is trusted. */
export function webhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;
}

/**
 * The client, or null when billing is not configured.
 *
 * Returning null rather than throwing means every caller has to decide what to
 * do without billing, which is the point: a page that shows the plan should
 * still render, and only the buttons that need Stripe should be unavailable.
 */
export function stripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  if (!client) {
    client = new Stripe(key, {
      // Pinned. Stripe changes response shapes between versions, and inheriting
      // whatever the account happens to be set to means a dashboard setting
      // somebody else changes can alter what this code receives.
      apiVersion: "2026-07-29.dahlia",
      // Named so a failing call is identifiable in Stripe's own logs rather
      // than appearing as one of many anonymous integrations.
      appInfo: { name: "YourCRM" },
      maxNetworkRetries: 2,
      timeout: 15_000,
    });
  }
  return client;
}

/** Where Stripe should send people back to. */
export function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3100")
  );
}
