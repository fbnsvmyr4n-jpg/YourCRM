/**
 * The published price list, and how it maps to Stripe.
 *
 * Two identifiers exist for the same thing and they must not drift: `plan` is
 * the value in the `agencies.plan` column and the key into `plan_entitlements`;
 * the Stripe price id is what a subscription actually carries. The mapping
 * lives here, once, in both directions.
 *
 * Price ids come from the environment because they differ between Stripe's test
 * and live modes. Hardcoding them would mean a test-mode id shipping to
 * production, where it silently fails to match any real subscription — and a
 * subscription that matches nothing leaves an agency paying with no plan.
 */

export const PLANS = ["starter", "unlimited", "saas_pro"] as const;
export type Plan = (typeof PLANS)[number];

/** Everyone starts here. Long enough to import contacts and run a week of calls. */
export const TRIAL_DAYS = 14;

export type PlanInfo = {
  plan: Plan;
  name: string;
  /** Monthly price in cents, for display. Stripe remains the source of truth. */
  priceCents: number;
  blurb: string;
};

export const PLAN_INFO: Record<Plan, PlanInfo> = {
  starter: {
    plan: "starter",
    name: "Starter",
    priceCents: 9700,
    blurb: "Up to 3 client workspaces, with the full CRM and calendar.",
  },
  unlimited: {
    plan: "unlimited",
    name: "Unlimited",
    priceCents: 29700,
    blurb: "Unlimited workspaces, the API, and your own branding.",
  },
  saas_pro: {
    plan: "saas_pro",
    name: "SaaS Pro",
    priceCents: 49700,
    blurb: "Resell YourCRM to your own clients and bill them yourself.",
  },
};

/** The environment variable holding each plan's Stripe price id. */
const PRICE_ENV: Record<Plan, string> = {
  starter: "STRIPE_PRICE_STARTER",
  unlimited: "STRIPE_PRICE_UNLIMITED",
  saas_pro: "STRIPE_PRICE_SAAS_PRO",
};

export function priceIdFor(plan: Plan): string | null {
  return process.env[PRICE_ENV[plan]]?.trim() || null;
}

/**
 * Which plan a Stripe price id belongs to.
 *
 * Returns null for an id we do not recognise rather than guessing a default. A
 * webhook naming an unknown price means the Stripe catalogue and this
 * deployment disagree, and quietly resolving that to `starter` would downgrade
 * somebody who is paying for more.
 */
export function planForPriceId(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  for (const plan of PLANS) {
    if (priceIdFor(plan) === priceId) return plan;
  }
  return null;
}

export function isPlan(value: string): value is Plan {
  return (PLANS as readonly string[]).includes(value);
}

/** When a trial started now would end. */
export function trialEndsAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}
