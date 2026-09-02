import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapStatus, readSubscription } from "../src/server/billing/subscription";
import { PLANS, isPlan, planForPriceId, priceIdFor, trialEndsAt, TRIAL_DAYS } from "../src/server/billing/plans";
import { checkoutParams, trialDaysLeft, trialSecondsLeft } from "../src/server/billing/checkout";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDb, AGENCY } from "./helpers/pg";

const SCHEMA_SQL = readFileSync(
  join(__dirname, "..", "src", "server", "schema.sql"),
  "utf8"
);

/**
 * Subscriptions, trials, and the events that change them.
 *
 * The failures worth catching here are asymmetric. Wrongly granting access is
 * silent — a happy customer, no invoice, nothing in any log. Wrongly revoking
 * it is loud and gets fixed the same afternoon. So the cases that get the most
 * attention are the ones where being wrong means giving the product away.
 *
 * The mapping tests need no database: keeping the decision in a pure function
 * is what lets every Stripe status be checked without a key or a network.
 */

const PRICE = {
  starter: "price_test_starter",
  unlimited: "price_test_unlimited",
  saas_pro: "price_test_saas",
};

beforeEach(() => {
  process.env.STRIPE_PRICE_STARTER = PRICE.starter;
  process.env.STRIPE_PRICE_UNLIMITED = PRICE.unlimited;
  process.env.STRIPE_PRICE_SAAS_PRO = PRICE.saas_pro;
});

afterEach(() => {
  delete process.env.STRIPE_PRICE_STARTER;
  delete process.env.STRIPE_PRICE_UNLIMITED;
  delete process.env.STRIPE_PRICE_SAAS_PRO;
});

describe("every Stripe status maps to a decision", () => {
  it("keeps access while paying, trialing, or recoverable", () => {
    expect(mapStatus("active")).toBe("active");
    expect(mapStatus("trialing")).toBe("trialing");
    // Stripe retries a failed card for about two weeks. Locking somebody out
    // on day one of that loses a customer over a problem they would have fixed.
    expect(mapStatus("past_due")).toBe("past_due");
  });

  it("ends access once the retries are exhausted", () => {
    // `unpaid` is the END of the dunning road, not a softer past_due. Treating
    // it as one is indefinite free access for a card that has definitively
    // failed — and it is the mistake that looks most reasonable in review.
    expect(mapStatus("unpaid"), "an exhausted subscription kept its access").toBe("canceled");
    expect(mapStatus("canceled")).toBe("canceled");
  });

  it("gives nothing for a subscription that never started", () => {
    // The first payment failed. Nothing was ever bought.
    expect(mapStatus("incomplete")).toBe("canceled");
    expect(mapStatus("incomplete_expired")).toBe("canceled");
  });

  it("stops access when collection is paused", () => {
    expect(mapStatus("paused"), "a paused subscription ran on unbilled").toBe("canceled");
  });

  it("fails closed on a status nobody has decided about", () => {
    /**
     * Stripe adds statuses over time. The safe direction for an unknown one is
     * the visible failure — an upgrade prompt, a support message, fixed the
     * same day — rather than the invisible one, which is the product being
     * given away until somebody notices the revenue.
     */
    for (const unknown of ["", "will_be_active", "something_new", "ACTIVE"]) {
      expect(mapStatus(unknown), `"${unknown}" was treated as granting access`).toBe("canceled");
    }
  });

  it("covers every status Stripe currently documents", () => {
    // A status missing from the map is not a bug — it falls through to
    // canceled. But it should be a decision somebody made, so the list is here.
    const documented = [
      "trialing", "active", "past_due", "unpaid",
      "canceled", "incomplete", "incomplete_expired", "paused",
    ];
    for (const status of documented) {
      expect(["trialing", "active", "past_due", "canceled"]).toContain(mapStatus(status));
    }
  });
});

describe("a subscription is read into the columns the app uses", () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    id: "sub_123",
    status: "active",
    customer: "cus_123",
    items: { data: [{ price: { id: PRICE.unlimited } }] },
    ...over,
  });

  it("takes the plan from the price id", () => {
    expect(readSubscription(sub(), "starter").plan).toBe("unlimited");
  });

  it("keeps the current plan when the price is unrecognised", () => {
    /**
     * A catalogue mismatch between Stripe and this deployment. Guessing the
     * cheapest tier would DOWNGRADE somebody who is paying for more — a real
     * customer losing real features because of a configuration error that is
     * not theirs. Keeping what they have is the least wrong answer.
     */
    const state = readSubscription(sub({ items: { data: [{ price: { id: "price_unknown" } }] } }), "saas_pro");
    expect(state.plan, "an unknown price silently downgraded a paying customer").toBe("saas_pro");
  });

  it("survives a subscription with no items at all", () => {
    const state = readSubscription(sub({ items: undefined }), "unlimited");
    expect(state.plan).toBe("unlimited");
  });

  it("reads the trial end as seconds, not milliseconds", () => {
    // Stripe sends seconds. Forgetting the factor of 1000 produces a date in
    // 1970 — a trial that ended before it began, and an account locked out on
    // the day it signed up.
    const at = Math.floor(Date.UTC(2026, 8, 5, 12) / 1000);
    const state = readSubscription(sub({ trial_end: at }), "starter");
    expect(state.trialEndsAt?.getUTCFullYear()).toBe(2026);
  });

  it("has no trial end when there is no trial", () => {
    expect(readSubscription(sub(), "starter").trialEndsAt).toBeNull();
  });

  it("reads the customer whether it is an id or an object", () => {
    expect(readSubscription(sub(), "starter").stripeCustomerId).toBe("cus_123");
    expect(readSubscription(sub({ customer: { id: "cus_obj" } }), "starter").stripeCustomerId).toBe(
      "cus_obj"
    );
  });
});

describe("the price list and Stripe agree in both directions", () => {
  it("maps every plan to a price and back", () => {
    for (const plan of PLANS) {
      const id = priceIdFor(plan);
      expect(id, `${plan} has no price id configured`).toBeTruthy();
      expect(planForPriceId(id), `${plan} did not round-trip through its price id`).toBe(plan);
    }
  });

  it("refuses to guess for an unknown or absent price", () => {
    expect(planForPriceId("price_nope")).toBeNull();
    expect(planForPriceId(null)).toBeNull();
    expect(planForPriceId(undefined)).toBeNull();
    expect(planForPriceId("")).toBeNull();
  });

  it("has no price id when the environment does not set one", () => {
    // A deployment without billing configured must report "not configured",
    // never a stale or placeholder id that matches nothing in Stripe.
    delete process.env.STRIPE_PRICE_STARTER;
    expect(priceIdFor("starter")).toBeNull();
    expect(planForPriceId(PRICE.starter)).toBeNull();
  });

  it("knows which strings are plans", () => {
    expect(isPlan("starter")).toBe(true);
    expect(isPlan("enterprise")).toBe(false);
    expect(isPlan("")).toBe(false);
  });
});

describe("the trial has a length", () => {
  it("ends 14 days out", () => {
    const from = new Date("2026-08-22T09:00:00Z");
    const ends = trialEndsAt(from);
    const days = (ends.getTime() - from.getTime()) / 86_400_000;
    expect(days).toBe(TRIAL_DAYS);
    expect(days, "the trial is not 14 days").toBe(14);
  });

  it("is in the future", () => {
    expect(trialEndsAt().getTime()).toBeGreaterThan(Date.now());
  });
});

describe("the remaining trial is carried into checkout", () => {
  const now = new Date("2026-08-22T12:00:00Z");

  it("hands Stripe the existing trial end, so the days already promised survive", () => {
    /**
     * Somebody subscribing on day 3 of a 14-day trial keeps the other eleven.
     * Without this they are charged immediately — a small amount of money and a
     * large amount of goodwill, and the kind of thing that produces a refund
     * request rather than a renewal.
     */
    const ends = new Date("2026-09-02T12:00:00Z");
    expect(trialSecondsLeft(ends, now)).toBe(Math.floor(ends.getTime() / 1000));
  });

  it("drops a trial too close to send", () => {
    // Stripe rejects a trial_end under 48 hours away. Losing the last day of a
    // trial is a smaller harm than a checkout page that will not open at all.
    expect(trialSecondsLeft(new Date("2026-08-23T12:00:00Z"), now)).toBeNull();
    expect(trialSecondsLeft(new Date("2026-08-24T11:00:00Z"), now)).toBeNull();
  });

  it("sends a trial just over the limit", () => {
    expect(trialSecondsLeft(new Date("2026-08-24T13:00:00Z"), now)).not.toBeNull();
  });

  it("sends nothing when there is no trial, or it has passed", () => {
    expect(trialSecondsLeft(null, now)).toBeNull();
    expect(trialSecondsLeft(new Date("2026-08-01T12:00:00Z"), now)).toBeNull();
  });
});

describe("the checkout session carries what the webhook will need", () => {
  const base = {
    agencyId: "ag_1",
    price: "price_x",
    ownerEmail: "owner@example.com",
    existingCustomerId: null,
    trialEnd: null,
    returnTo: "https://app.example.com",
  };

  it("names the account, so the payment can be attached to it", () => {
    /**
     * The single most consequential field here. Without it the webhook receives
     * a checkout session for a customer it cannot place, the payment succeeds,
     * and the account stays on its trial. The customer has paid and nothing
     * happened — and nothing errors, on either side.
     */
    expect(
      checkoutParams(base).client_reference_id,
      "checkout does not say which account is paying"
    ).toBe("ag_1");
    expect(checkoutParams(base).subscription_data.metadata.agency_id).toBe("ag_1");
  });

  it("reuses an existing Stripe customer rather than making a second", () => {
    // Two customers for one agency means the webhook resolves to whichever was
    // linked first, and the newer payment appears to do nothing at all.
    const params = checkoutParams({ ...base, existingCustomerId: "cus_known" });
    expect("customer" in params && params.customer).toBe("cus_known");
    expect("customer_email" in params, "a duplicate customer would be created").toBe(false);
  });

  it("identifies a first-time customer by email", () => {
    const params = checkoutParams(base);
    expect("customer_email" in params && params.customer_email).toBe("owner@example.com");
    expect("customer" in params).toBe(false);
  });

  it("carries the remaining trial across", () => {
    const at = 1_800_000_000;
    expect(checkoutParams({ ...base, trialEnd: at }).subscription_data.trial_end).toBe(at);
  });

  it("sends no trial when there is none left to carry", () => {
    // Sending `trial_end: null` is not the same as omitting it; Stripe reads a
    // present-but-empty value as an instruction rather than an absence.
    expect("trial_end" in checkoutParams(base).subscription_data).toBe(false);
  });

  it("buys the price it was given", () => {
    expect(checkoutParams(base).line_items[0].price).toBe("price_x");
    expect(checkoutParams(base).mode).toBe("subscription");
  });

  it("returns the customer to this deployment, not a hardcoded host", () => {
    const params = checkoutParams(base);
    expect(params.success_url.startsWith("https://app.example.com")).toBe(true);
    expect(params.cancel_url.startsWith("https://app.example.com")).toBe(true);
    // Distinct: landing on the same page either way leaves somebody who
    // abandoned checkout being told it succeeded.
    expect(params.success_url).not.toBe(params.cancel_url);
  });
});

describe("days left on a trial, as a person would count them", () => {
  const now = new Date("2026-08-22T12:00:00Z");

  it("rounds up, because six hours left is not zero days", () => {
    // "0 days left" on an account that still works reads as already over.
    expect(trialDaysLeft(new Date("2026-08-22T18:00:00Z"), now)).toBe(1);
    expect(trialDaysLeft(new Date("2026-08-23T12:00:00Z"), now)).toBe(1);
    expect(trialDaysLeft(new Date("2026-08-28T12:00:00Z"), now)).toBe(6);
  });

  it("is zero once the trial has passed, never negative", () => {
    expect(trialDaysLeft(new Date("2026-08-21T12:00:00Z"), now)).toBe(0);
    expect(trialDaysLeft(null, now)).toBe(0);
  });

  it("never claims more days than the trial ever had", () => {
    // A bad `trial_ends_at` — a manual edit, a bad import — must not display as
    // a year of free access.
    expect(trialDaysLeft(new Date("2027-08-22T12:00:00Z"), now)).toBe(TRIAL_DAYS);
  });

  it("reads a date that arrives as a string", () => {
    expect(trialDaysLeft("2026-08-28T12:00:00Z", now)).toBe(6);
  });
});

/* ------------------------------------------------------------------ */
/* Against a real database                                            */
/* ------------------------------------------------------------------ */

let db: TestDb;
let withSystem: typeof import("../src/server/tenant").withSystem;
let handleStripeEvent: typeof import("../src/server/billing/webhook").handleStripeEvent;
let entitlementsFor: typeof import("../src/server/entitlements").entitlementsFor;
let signUpNewTenant: typeof import("../src/server/signup").signUpNewTenant;
let closePool: typeof import("../src/server/db").closePool;

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ handleStripeEvent } = await import("../src/server/billing/webhook"));
  ({ entitlementsFor } = await import("../src/server/entitlements"));
  ({ signUpNewTenant } = await import("../src/server/signup"));
  ({ closePool } = await import("../src/server/db"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const CUSTOMER = "cus_fixture";
let clock = 1_700_000_000;

beforeEach(async () => {
  await db.seed(`DELETE FROM stripe_events`);
  // The other-agency fixture holds a subscription id, and the column is unique
  // across the platform — correctly, since a Stripe subscription belongs to one
  // customer. Cleared between tests so the fixtures do not collide with each
  // other rather than with a real rule.
  await db.seed(`DELETE FROM agencies WHERE id = 'ag_other'`);
  await db.seed(
    `UPDATE agencies SET plan = 'starter', plan_status = 'trialing',
       trial_ends_at = now() + interval '14 days',
       stripe_customer_id = '${CUSTOMER}', stripe_subscription_id = NULL,
       billing_synced_at = NULL
     WHERE id = '${AGENCY}'`
  );
});

const event = (
  type: string,
  object: Record<string, unknown>,
  over: { id?: string; created?: number } = {}
) => ({
  id: over.id ?? `evt_${Math.random().toString(36).slice(2)}`,
  type,
  created: over.created ?? clock++,
  data: { object },
});

const subscription = (over: Record<string, unknown> = {}) => ({
  id: "sub_fixture",
  status: "active",
  customer: CUSTOMER,
  items: { data: [{ price: { id: PRICE.unlimited } }] },
  ...over,
});

const send = (e: ReturnType<typeof event>) => withSystem((q) => handleStripeEvent(q, e));
const agency = () =>
  withSystem((q) =>
    q.one<{ plan: string; plan_status: string; stripe_subscription_id: string | null }>(
      `SELECT plan, plan_status, stripe_subscription_id FROM agencies WHERE id = $1`,
      [AGENCY]
    )
  );

describe("a subscription event moves the agency onto its plan", () => {
  it("activates the plan that was bought", async () => {
    const r = await send(event("customer.subscription.created", subscription()));
    expect(r.ok && r.action).toBe("applied");

    const a = await agency();
    expect(a?.plan).toBe("unlimited");
    expect(a?.plan_status).toBe("active");
    expect(a?.stripe_subscription_id).toBe("sub_fixture");
  });

  it("grants what the new plan includes, immediately", async () => {
    // The point of the whole exercise: paying changes what the product does.
    await send(event("customer.subscription.created", subscription()));
    const e = await withSystem((q) => entitlementsFor(q, AGENCY));
    expect(e.active).toBe(true);
    expect(e.grants.has("api_access"), "the paid plan's features were not granted").toBe(true);
  });

  it("keeps access while a payment is being retried", async () => {
    await send(event("customer.subscription.updated", subscription({ status: "past_due" })));
    const e = await withSystem((q) => entitlementsFor(q, AGENCY));
    expect(e.active, "a customer was locked out on the first failed charge").toBe(true);
    expect(e.inGrace).toBe(true);
  });

  it("ends access when the subscription is deleted", async () => {
    await send(event("customer.subscription.created", subscription()));
    // Stripe sends the subscription as it WAS, and its status field has been
    // observed reading "active" on a deleted subscription. The event type is
    // the fact; the object's status is not.
    await send(event("customer.subscription.deleted", subscription({ status: "active" })));

    const a = await agency();
    expect(a?.plan_status, "a deleted subscription kept its access").toBe("canceled");
    const e = await withSystem((q) => entitlementsFor(q, AGENCY));
    expect(e.active).toBe(false);
    expect(e.grants.size).toBe(0);
  });
});

describe("delivery is at-least-once and out of order", () => {
  it("ignores a redelivered event", async () => {
    const e = event("customer.subscription.created", subscription());
    const first = await send(e);
    expect(first.ok && first.action).toBe("applied");

    const second = await send(e);
    expect(second.ok && second.action === "ignored" ? second.reason : "applied again").toBe(
      "duplicate"
    );

    const rows = await withSystem((q) =>
      q.rows<{ id: string }>(`SELECT id FROM stripe_events WHERE id = $1`, [e.id])
    );
    expect(rows.length, "the same event was recorded twice").toBe(1);
  });

  it("does not resurrect a cancelled subscription with a delayed update", async () => {
    /**
     * The failure this prevents: an `updated` event is retried, arrives after
     * the `deleted` that followed it, and puts the account back on its plan.
     * The customer cancelled, the product keeps working, and nobody is billed.
     */
    const cancelledAt = clock + 100;
    await send(event("customer.subscription.deleted", subscription(), { created: cancelledAt }));
    expect((await agency())?.plan_status).toBe("canceled");

    const late = event("customer.subscription.updated", subscription({ status: "active" }), {
      created: cancelledAt - 50,
    });
    const r = await send(late);

    expect(r.ok && r.action, "a stale event was applied").toBe("ignored");
    expect((await agency())?.plan_status, "a cancelled subscription came back to life").toBe(
      "canceled"
    );
  });

  it("applies an event that is genuinely newer", async () => {
    // The mirror image: the guard must not reject real changes.
    const at = clock + 200;
    await send(event("customer.subscription.updated", subscription({ status: "past_due" }), { created: at }));
    await send(event("customer.subscription.updated", subscription({ status: "active" }), { created: at + 10 }));
    expect((await agency())?.plan_status).toBe("active");
  });

  it("applies two events sent in the same second", async () => {
    // Stripe's timestamps are whole seconds, so simultaneous events are normal.
    // A strictly-greater comparison would drop the second one.
    const at = clock + 300;
    await send(event("customer.subscription.created", subscription({ status: "trialing" }), { created: at }));
    await send(event("customer.subscription.updated", subscription({ status: "active" }), { created: at }));
    expect((await agency())?.plan_status, "an event in the same second was dropped").toBe("active");
  });
});

describe("events that belong to nobody", () => {
  it("ignores a subscription for an unknown customer, and says so", async () => {
    /**
     * Almost always a test-mode endpoint receiving live traffic or the reverse.
     *
     * The reason is asserted, not just the outcome. Without the explicit
     * branch the UPDATE matches no row and the event is ignored anyway — same
     * result, but reported as "stale" and with no log line. That log is the
     * only signal that a customer has paid and their account never activated,
     * so losing it means the failure is silent on both sides.
     */
    const r = await send(
      event("customer.subscription.created", subscription({ customer: "cus_stranger" }))
    );
    expect(r.ok).toBe(true);
    expect(
      r.ok && r.action === "ignored" ? r.reason : `outcome was ${JSON.stringify(r)}`,
      "an unrecognised customer was not identified as such"
    ).toBe("unknown_customer");
    expect((await agency())?.plan_status, "a stranger's subscription changed an account").toBe(
      "trialing"
    );
  });

  it("does not let one agency's event touch another's row", async () => {
    await db.seed(
      `INSERT INTO agencies (id, name, stripe_customer_id) VALUES ('ag_other', 'Other', 'cus_other')
       ON CONFLICT (id) DO UPDATE SET stripe_customer_id = 'cus_other'`
    );
    await send(
      event(
        "customer.subscription.created",
        subscription({ customer: "cus_other", id: "sub_other" })
      )
    );

    expect((await agency())?.plan_status, "the wrong agency was updated").toBe("trialing");
    const other = await withSystem((q) =>
      q.one<{ plan_status: string }>(`SELECT plan_status FROM agencies WHERE id = 'ag_other'`)
    );
    expect(other?.plan_status).toBe("active");
  });

  it("records an unhandled event type so a redelivery is still a no-op", async () => {
    const e = event("invoice.paid", { id: "in_1" });
    const r = await send(e);
    expect(r.ok && r.action).toBe("ignored");
    const rows = await withSystem((q) =>
      q.rows<{ id: string }>(`SELECT id FROM stripe_events WHERE id = $1`, [e.id])
    );
    expect(rows.length).toBe(1);
  });
});

describe("checkout links the customer to the account", () => {
  it("attaches the Stripe customer so later events can find the agency", async () => {
    await db.seed(`UPDATE agencies SET stripe_customer_id = NULL WHERE id = '${AGENCY}'`);

    const r = await send(
      event("checkout.session.completed", {
        client_reference_id: AGENCY,
        customer: "cus_fresh",
      })
    );
    expect(r.ok && r.action).toBe("linked");

    // Without this link the payment succeeds and the account stays on trial —
    // the customer has paid and nothing changed.
    await send(event("customer.subscription.created", subscription({ customer: "cus_fresh" })));
    expect((await agency())?.plan_status).toBe("active");
  });

  it("refuses a session carrying no account", async () => {
    const r = await send(event("checkout.session.completed", { customer: "cus_x" }));
    expect(r.ok).toBe(false);
  });
});

describe("a new account is on a trial that actually ends", () => {
  it("sets an end date at signup", async () => {
    /**
     * This was the live defect. `entitlementsFor` only expired a trial that had
     * an end date, and signup left it NULL — so every account ever created was
     * on a permanent free trial. Nothing errored and no invoice was ever due.
     */
    const r = await withSystem((q) =>
      signUpNewTenant(q, {
        name: "Trial Co",
        email: `trial-${Date.now()}@example.com`,
        password: "password1",
      })
    );
    expect(r.agencyId, r.error ?? "signup failed").toBeTruthy();

    const e = await withSystem((q) => entitlementsFor(q, r.agencyId!));
    expect(e.trialEndsAt, "a new account's trial has no end date").not.toBeNull();
    expect(e.active).toBe(true);

    const days = (new Date(e.trialEndsAt!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(TRIAL_DAYS - 1);
    expect(days).toBeLessThanOrEqual(TRIAL_DAYS);
  });

  it("does not lock out an account that predates the fix", async () => {
    /**
     * Both live agencies were `trialing` with no end date when this shipped.
     * Making an unbounded trial count as over — correct in itself — would have
     * locked them out on the next request, including the account belonging to
     * the person deploying it.
     *
     * The schema backfills those rows with fourteen days from the moment it
     * runs. Not from `created_at`: nobody was ever told their trial had
     * started, so backdating the clock would expire accounts on the same day
     * the fix arrived.
     *
     * The whole schema is re-applied here, which is also what proves the
     * backfill is safe to re-run.
     */
    await db.seed(
      `UPDATE agencies SET plan_status = 'trialing', trial_ends_at = NULL WHERE id = '${AGENCY}'`
    );
    await db.seed(SCHEMA_SQL);

    const after = await withSystem((q) =>
      q.one<{ trial_ends_at: Date | null }>(
        `SELECT trial_ends_at FROM agencies WHERE id = $1`,
        [AGENCY]
      )
    );
    expect(after?.trial_ends_at, "an existing account was left with no trial end").not.toBeNull();

    const e = await withSystem((q) => entitlementsFor(q, AGENCY));
    expect(e.active, "an account that predates the fix was locked out").toBe(true);
  });

  it("gives a long-standing account the full fourteen days, not a backdated one", async () => {
    /**
     * The live accounts are weeks old. Dating the backfill from `created_at`
     * would hand them a trial that expired before the fix even shipped —
     * technically consistent, and it locks the customer out the moment they
     * next load a page. They were never told a trial had started, so the clock
     * starts when the rule does.
     */
    await db.seed(
      `INSERT INTO agencies (id, name, plan_status, trial_ends_at, created_at)
       VALUES ('ag_old', 'Long-standing', 'trialing', NULL, now() - interval '90 days')
       ON CONFLICT (id) DO UPDATE
         SET plan_status = 'trialing', trial_ends_at = NULL,
             created_at = now() - interval '90 days'`
    );
    await db.seed(SCHEMA_SQL);

    const e = await withSystem((q) => entitlementsFor(q, "ag_old"));
    expect(
      e.active,
      "an account created three months ago was expired the moment the fix shipped"
    ).toBe(true);

    const days =
      (new Date(e.trialEndsAt!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13);
  });

  it("does not extend a trial a second time when the schema is re-applied", async () => {
    // Self-limiting, not merely idempotent: the WHERE clause stops matching
    // once it has run. Re-applying the schema every deploy must not hand every
    // trialing account another fortnight, forever.
    await db.seed(
      `UPDATE agencies SET plan_status = 'trialing', trial_ends_at = NULL WHERE id = '${AGENCY}'`
    );
    await db.seed(SCHEMA_SQL);
    const first = await withSystem((q) =>
      q.one<{ t: Date }>(`SELECT trial_ends_at AS t FROM agencies WHERE id = $1`, [AGENCY])
    );

    await db.seed(SCHEMA_SQL);
    const second = await withSystem((q) =>
      q.one<{ t: Date }>(`SELECT trial_ends_at AS t FROM agencies WHERE id = $1`, [AGENCY])
    );

    expect(second?.t.getTime(), "the trial was extended by re-running the schema").toBe(
      first?.t.getTime()
    );
  });

  it("treats a trial with no end date as over", async () => {
    // Belt as well as braces: signup sets the date now, but rows written before
    // the fix exist, and an unbounded trial is not a trial.
    await db.seed(
      `UPDATE agencies SET plan_status = 'trialing', trial_ends_at = NULL WHERE id = '${AGENCY}'`
    );
    const e = await withSystem((q) => entitlementsFor(q, AGENCY));
    expect(e.active, "a trial with no end date granted access forever").toBe(false);
    expect(e.reason).toBe("trial_expired");
  });
});
