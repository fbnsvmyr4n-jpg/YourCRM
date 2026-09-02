import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_INVOICE_SHARE,
  REWARD_RATE,
  applicableCredit,
  generateCode,
} from "../src/server/referral-rewards";
import { startTestDb, type TestDb, AGENCY } from "./helpers/pg";

/**
 * Paying agencies for the agencies they send.
 *
 * Credit rather than a discount: a discount cuts the price permanently and
 * quietly reduces MRR, so the revenue line stops saying what the product costs
 * and every cohort comparison after it is polluted. Credit is a one-off balance
 * — same value to the customer, and the price never moved.
 *
 * This is money leaving the business, so the cases that get the most attention
 * are the ones where being wrong pays somebody twice, pays them for their own
 * payments, or lets an account stop paying altogether.
 */

describe("how much credit an invoice may take", () => {
  it("takes the smaller of the balance and half the bill", () => {
    expect(applicableCredit(10000, 9700)).toBe(4850);
    expect(applicableCredit(1000, 9700)).toBe(1000);
  });

  it("never covers more than half, however much credit there is", () => {
    /**
     * The cap Bradley asked for, and the reason for it: credit that could
     * clear a whole invoice means an agency with enough referrals stops paying
     * anything at all — and a customer paying nothing is one whose renewal
     * nobody notices lapsing.
     */
    const invoice = 9700;
    expect(applicableCredit(1_000_000, invoice)).toBe(Math.floor(invoice * MAX_INVOICE_SHARE));
    expect(applicableCredit(1_000_000, invoice)).toBeLessThan(invoice);
  });

  it("never invents money the account does not have", () => {
    expect(applicableCredit(0, 9700)).toBe(0);
    expect(applicableCredit(-500, 9700)).toBe(0);
  });

  it("applies nothing to an invoice of nothing", () => {
    expect(applicableCredit(10000, 0)).toBe(0);
  });

  it("rounds down, so credit is never more generous than it should be", () => {
    // Half of 97 cents is 48.5. Rounding up would hand out a cent that was
    // never earned, on every invoice, for ever.
    expect(applicableCredit(10000, 97)).toBe(48);
  });
});

describe("referral codes", () => {
  it("is eight characters and avoids the ambiguous ones", () => {
    // These get typed off a screenshot and read down a phone. A code with an
    // O and a 0 in it produces support mail rather than signups.
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toHaveLength(8);
      expect(code, `${code} contains an ambiguous character`).not.toMatch(/[O0I1]/);
      expect(code).toMatch(/^[A-Z2-9]+$/);
    }
  });

  it("is not derived from anything about the agency", () => {
    // A code is a public token that goes in a URL and gets read aloud. Derived
    // from a name it would be neither stable nor necessarily something its
    // owner wants published.
    const a = generateCode(() => 0.1);
    const b = generateCode(() => 0.9);
    expect(a).not.toBe(b);
  });
});

/* ------------------------------------------------------------------ */
/* Against a real database                                            */
/* ------------------------------------------------------------------ */

let db: TestDb;
let withSystem: typeof import("../src/server/tenant").withSystem;
let rewards: typeof import("../src/server/referral-rewards");
let closePool: typeof import("../src/server/db").closePool;

const OTHER = "ag_referred";

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  rewards = await import("../src/server/referral-rewards");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  await db.seed(`
    DELETE FROM referral_credits;
    UPDATE agencies SET referral_code = NULL, referred_by_agency_id = NULL;
    INSERT INTO agencies (id, name) VALUES ('${OTHER}', 'Referred Agency')
      ON CONFLICT (id) DO UPDATE SET referral_code = NULL, referred_by_agency_id = NULL;
  `);
});

describe("a code belongs to one agency", () => {
  it("creates one on first use and keeps it afterwards", async () => {
    const first = await withSystem((q) => rewards.referralCodeFor(q, AGENCY));
    const second = await withSystem((q) => rewards.referralCodeFor(q, AGENCY));
    expect(first).toHaveLength(8);
    expect(second, "the code changed between reads").toBe(first);
  });

  it("resolves back to its agency, ignoring case and spacing", async () => {
    const code = await withSystem((q) => rewards.referralCodeFor(q, AGENCY));
    expect(await withSystem((q) => rewards.agencyForCode(q, code!.toLowerCase()))).toBe(AGENCY);
    expect(await withSystem((q) => rewards.agencyForCode(q, `  ${code}  `))).toBe(AGENCY);
  });

  it("resolves nothing for a code that does not exist", async () => {
    expect(await withSystem((q) => rewards.agencyForCode(q, "ZZZZZZZZ"))).toBeNull();
    expect(await withSystem((q) => rewards.agencyForCode(q, ""))).toBeNull();
  });
});

describe("attribution happens once, at signup", () => {
  it("records who sent them", async () => {
    const code = await withSystem((q) => rewards.referralCodeFor(q, AGENCY));
    const result = await withSystem((q) => rewards.attributeSignup(q, OTHER, code!));
    expect(result.referrerId).toBe(AGENCY);

    const row = await withSystem((q) =>
      q.one<{ referred_by_agency_id: string }>(
        `SELECT referred_by_agency_id FROM agencies WHERE id = $1`,
        [OTHER]
      )
    );
    expect(row?.referred_by_agency_id).toBe(AGENCY);
  });

  it("refuses a self-referral", async () => {
    /**
     * The first thing anybody tries. An agency referring itself would earn
     * credit on its own payments — a discount by another name, which is
     * precisely what this design exists to avoid.
     */
    const code = await withSystem((q) => rewards.referralCodeFor(q, AGENCY));
    const result = await withSystem((q) => rewards.attributeSignup(q, AGENCY, code!));
    expect(result.referrerId, "an agency referred itself").toBeNull();

    const row = await withSystem((q) =>
      q.one<{ referred_by_agency_id: string | null }>(
        `SELECT referred_by_agency_id FROM agencies WHERE id = $1`,
        [AGENCY]
      )
    );
    expect(row?.referred_by_agency_id).toBeNull();
  });

  it("cannot be claimed later by somebody else", async () => {
    // Attribution belongs to the moment of signup. Allowing it to be set again
    // would let an agency claim a customer another had already brought in.
    const code = await withSystem((q) => rewards.referralCodeFor(q, AGENCY));
    await withSystem((q) => rewards.attributeSignup(q, OTHER, code!));

    await db.seed(
      `INSERT INTO agencies (id, name, referral_code) VALUES ('ag_latecomer', 'Latecomer', 'LATECOME')
       ON CONFLICT (id) DO UPDATE SET referral_code = 'LATECOME'`
    );
    await withSystem((q) => rewards.attributeSignup(q, OTHER, "LATECOME"));

    const row = await withSystem((q) =>
      q.one<{ referred_by_agency_id: string }>(
        `SELECT referred_by_agency_id FROM agencies WHERE id = $1`,
        [OTHER]
      )
    );
    expect(row?.referred_by_agency_id, "a second agency claimed the referral").toBe(AGENCY);
  });

  it("ignores a code that matches nothing rather than refusing the signup", async () => {
    const result = await withSystem((q) => rewards.attributeSignup(q, OTHER, "NOTACODE"));
    expect(result.referrerId).toBeNull();
  });
});

describe("earning from a referred agency's payments", () => {
  const referred = async () => {
    const code = await withSystem((q) => rewards.referralCodeFor(q, AGENCY));
    await withSystem((q) => rewards.attributeSignup(q, OTHER, code!));
  };

  it("credits the referrer a share of what was paid", async () => {
    await referred();
    const result = await withSystem((q) => rewards.earnFromPayment(q, OTHER, 9700, "in_1"));
    expect(result.referrerId).toBe(AGENCY);
    expect(result.earned).toBe(Math.floor(9700 * REWARD_RATE));

    const summary = await withSystem((q) => rewards.creditSummary(q, AGENCY));
    expect(summary.balanceCents).toBe(Math.floor(9700 * REWARD_RATE));
  });

  it("does not pay twice for the same invoice", async () => {
    /**
     * Stripe delivers at least once. Here a duplicate is not a wrong number on
     * a screen — it is money paid out again, every time the webhook is retried.
     */
    await referred();
    const first = await withSystem((q) => rewards.earnFromPayment(q, OTHER, 9700, "in_1"));
    const second = await withSystem((q) => rewards.earnFromPayment(q, OTHER, 9700, "in_1"));

    expect(first.earned).toBeGreaterThan(0);
    expect(second.earned, "the same invoice paid a referral twice").toBe(0);

    const summary = await withSystem((q) => rewards.creditSummary(q, AGENCY));
    expect(summary.entries.length).toBe(1);
  });

  it("earns again from the next invoice", async () => {
    // Recurring, so long as the referred agency keeps paying. That is what
    // makes the reward worth chasing rather than a one-off bounty.
    await referred();
    await withSystem((q) => rewards.earnFromPayment(q, OTHER, 9700, "in_1"));
    await withSystem((q) => rewards.earnFromPayment(q, OTHER, 9700, "in_2"));

    const summary = await withSystem((q) => rewards.creditSummary(q, AGENCY));
    expect(summary.entries.length).toBe(2);
    expect(summary.balanceCents).toBe(2 * Math.floor(9700 * REWARD_RATE));
  });

  it("pays nobody when the payer was not referred", async () => {
    const result = await withSystem((q) => rewards.earnFromPayment(q, OTHER, 9700, "in_1"));
    expect(result.earned).toBe(0);
    expect(result.referrerId).toBeNull();
  });

  it("pays nothing on a refund or a zero invoice, and names nobody", async () => {
    /**
     * A refund is not a payment with a negative referrer — it is not a payment
     * at all, and the result says so by naming no referrer rather than
     * reporting one who earned nothing. That distinction is what stops a
     * caller reading "referrer: X, earned: 0" as a reward worth retrying.
     */
    await referred();

    const zero = await withSystem((q) => rewards.earnFromPayment(q, OTHER, 0, "in_0"));
    expect(zero.earned).toBe(0);
    expect(zero.referrerId, "a zero invoice named a referrer to credit").toBeNull();

    const refund = await withSystem((q) => rewards.earnFromPayment(q, OTHER, -9700, "in_neg"));
    expect(refund.earned).toBe(0);
    expect(refund.referrerId, "a refund named a referrer to credit").toBeNull();

    const summary = await withSystem((q) => rewards.creditSummary(q, AGENCY));
    expect(summary.entries.length, "a refund created credit").toBe(0);
  });
});

describe("the balance is derived from entries", () => {
  it("adds what was earned and subtracts what was spent", async () => {
    await db.seed(`
      INSERT INTO referral_credits (id, agency_id, amount_cents, reason) VALUES
        ('rc1', '${AGENCY}', 5000, 'earned'),
        ('rc2', '${AGENCY}', 3000, 'earned'),
        ('rc3', '${AGENCY}', -2000, 'applied to an invoice')
    `);
    const summary = await withSystem((q) => rewards.creditSummary(q, AGENCY));
    expect(summary.earnedCents).toBe(8000);
    expect(summary.spentCents).toBe(2000);
    expect(summary.balanceCents).toBe(6000);
  });

  it("never reports a negative balance", async () => {
    // A negative would read as the customer owing us for a reward, which is
    // never what any of these entries mean.
    await db.seed(
      `INSERT INTO referral_credits (id, agency_id, amount_cents, reason)
       VALUES ('rc1', '${AGENCY}', -5000, 'clawback')`
    );
    const summary = await withSystem((q) => rewards.creditSummary(q, AGENCY));
    expect(summary.balanceCents).toBe(0);
  });

  it("keeps one agency's credit off another's balance", async () => {
    await db.seed(`
      INSERT INTO referral_credits (id, agency_id, amount_cents, reason) VALUES
        ('rc1', '${AGENCY}', 5000, 'mine'),
        ('rc2', '${OTHER}', 9999, 'theirs')
    `);
    const mine = await withSystem((q) => rewards.creditSummary(q, AGENCY));
    expect(mine.balanceCents, "another agency's credit appeared on this balance").toBe(5000);
  });

  it("is empty rather than broken for an agency that has earned nothing", async () => {
    const summary = await withSystem((q) => rewards.creditSummary(q, OTHER));
    expect(summary.balanceCents).toBe(0);
    expect(summary.entries).toEqual([]);
  });
});
