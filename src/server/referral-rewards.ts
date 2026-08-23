import { logWrite } from "./log";
import type { SystemQuery } from "./tenant";

/**
 * Paying agencies for the agencies they send.
 *
 * Credit rather than a discount, deliberately. A discount cuts the price
 * permanently and quietly reduces MRR — the revenue line stops saying what the
 * product costs, and every cohort comparison after it is polluted. Credit is a
 * one-off balance: the customer gets the same value, it is spent and gone, and
 * the price of the product never moved.
 *
 * Held as a ledger rather than a running total. A balance derived from entries
 * can be explained — "where did this $97 come from" has an answer — and a
 * correction is a new row rather than an edit that erases what it replaced.
 */

/** What a referrer earns, as a share of what the referred agency pays. */
export const REWARD_RATE = 0.2;

/**
 * The most of any one invoice that credit may cover.
 *
 * Half. Credit that could clear a whole invoice means an agency with enough
 * referrals stops paying anything at all, and a customer paying nothing is a
 * customer whose renewal nobody notices lapsing. Capping it keeps every account
 * a paying account, which is also what makes the reward affordable to offer.
 */
export const MAX_INVOICE_SHARE = 0.5;

export type CreditEntry = {
  id: string;
  amountCents: number;
  reason: string;
  fromAgencyId: string | null;
  createdAt: string;
};

export type CreditSummary = {
  /** Everything earned, less everything spent. Never negative. */
  balanceCents: number;
  earnedCents: number;
  spentCents: number;
  entries: CreditEntry[];
};

/**
 * A referral code for an agency.
 *
 * Deliberately not derived from the agency's name: a code is a public token
 * that goes in a URL and gets read aloud, and a name is neither stable nor
 * necessarily something its owner wants published. Ambiguous characters are
 * left out because these get typed from a screenshot.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCode(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return out;
}

/** This agency's code, creating one the first time it is asked for. */
export async function referralCodeFor(q: SystemQuery, agencyId: string): Promise<string | null> {
  const existing = await q.one<{ referral_code: string | null }>(
    `SELECT referral_code FROM agencies WHERE id = $1 AND deleted_at IS NULL`,
    [agencyId]
  );
  if (!existing) return null;
  if (existing.referral_code) return existing.referral_code;

  // Retried on collision rather than assumed unique. Eight characters from a
  // 32-letter alphabet is a trillion codes, but "unlikely" is not "impossible"
  // and the index would reject the second one.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const row = await q.one<{ referral_code: string }>(
      `UPDATE agencies SET referral_code = $2
       WHERE id = $1 AND deleted_at IS NULL AND referral_code IS NULL
         AND NOT EXISTS (SELECT 1 FROM agencies WHERE referral_code = $2)
       RETURNING referral_code`,
      [agencyId, code]
    );
    if (row) return row.referral_code;

    // Somebody else may have set it in the meantime — read it back rather than
    // overwriting theirs.
    const now = await q.one<{ referral_code: string | null }>(
      `SELECT referral_code FROM agencies WHERE id = $1`,
      [agencyId]
    );
    if (now?.referral_code) return now.referral_code;
  }
  return null;
}

/** The agency a code belongs to, or null. */
export async function agencyForCode(q: SystemQuery, code: string): Promise<string | null> {
  const clean = code.trim().toUpperCase();
  if (!clean) return null;
  const row = await q.one<{ id: string }>(
    `SELECT id FROM agencies WHERE referral_code = $1 AND deleted_at IS NULL`,
    [clean]
  );
  return row?.id ?? null;
}

/**
 * Record who referred a newly created agency.
 *
 * Only ever set once, and never to itself. Self-referral is the first thing
 * anybody tries, and an agency that refers itself would earn credit on its own
 * payments — a discount by another name, which is exactly what this design
 * exists to avoid.
 */
export async function attributeSignup(
  q: SystemQuery,
  newAgencyId: string,
  code: string
): Promise<{ referrerId: string | null }> {
  const referrerId = await agencyForCode(q, code);
  if (!referrerId || referrerId === newAgencyId) return { referrerId: null };

  await q.rows(
    `UPDATE agencies SET referred_by_agency_id = $2
     WHERE id = $1 AND deleted_at IS NULL AND referred_by_agency_id IS NULL`,
    [newAgencyId, referrerId]
  );
  return { referrerId };
}

/**
 * Earn credit from a payment the referred agency made.
 *
 * Keyed on the Stripe invoice, so a redelivered webhook cannot pay the same
 * referral twice — the same at-least-once problem the subscription events have,
 * and here it would be paying real money out repeatedly.
 */
export async function earnFromPayment(
  q: SystemQuery,
  payerAgencyId: string,
  amountPaidCents: number,
  stripeInvoiceId: string
): Promise<{ earned: number; referrerId: string | null }> {
  if (amountPaidCents <= 0) return { earned: 0, referrerId: null };

  const payer = await q.one<{ referred_by_agency_id: string | null }>(
    `SELECT referred_by_agency_id FROM agencies WHERE id = $1 AND deleted_at IS NULL`,
    [payerAgencyId]
  );
  const referrerId = payer?.referred_by_agency_id ?? null;
  if (!referrerId) return { earned: 0, referrerId: null };

  const amount = Math.floor(amountPaidCents * REWARD_RATE);
  if (amount <= 0) return { earned: 0, referrerId };

  const row = await q.one<{ id: string }>(
    `INSERT INTO referral_credits (id, agency_id, from_agency_id, amount_cents, reason, stripe_invoice_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     -- The predicate is repeated because the index is PARTIAL: Postgres will
     -- not match a partial unique index unless the conflict target carries the
     -- same WHERE clause, and without it the statement fails outright rather
     -- than de-duplicating.
     ON CONFLICT (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      `rc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      referrerId,
      payerAgencyId,
      amount,
      `${Math.round(REWARD_RATE * 100)}% of a referred agency's payment`,
      stripeInvoiceId,
    ]
  );

  if (!row) return { earned: 0, referrerId };

  logWrite("create", "referral_credit", { id: referrerId, detail: `${amount} cents` });
  return { earned: amount, referrerId };
}

/** What an agency has earned, spent, and has left. */
export async function creditSummary(q: SystemQuery, agencyId: string): Promise<CreditSummary> {
  const rows = await q.rows<{
    id: string;
    amount_cents: string;
    reason: string;
    from_agency_id: string | null;
    created_at: Date;
  }>(
    `SELECT id, amount_cents::text, reason, from_agency_id, created_at
     FROM referral_credits
     WHERE agency_id = $1
     ORDER BY created_at DESC`,
    [agencyId]
  );

  const entries = rows.map((r) => ({
    id: r.id,
    amountCents: Number(r.amount_cents),
    reason: r.reason,
    fromAgencyId: r.from_agency_id,
    createdAt: r.created_at.toISOString(),
  }));

  const earnedCents = entries.filter((e) => e.amountCents > 0).reduce((s, e) => s + e.amountCents, 0);
  const spentCents = entries.filter((e) => e.amountCents < 0).reduce((s, e) => s - e.amountCents, 0);

  return {
    // Clamped at zero. A negative balance would read as the customer owing
    // us for a reward, which is never what any of these entries mean.
    balanceCents: Math.max(0, earnedCents - spentCents),
    earnedCents,
    spentCents,
    entries,
  };
}

/**
 * How much credit may be applied to one invoice.
 *
 * The smaller of what they have and half the bill. Both halves matter: taking
 * more than the balance would invent money, and covering more than half the
 * invoice would leave an account paying nothing — and a customer paying nothing
 * is one whose lapse nobody notices.
 */
export function applicableCredit(balanceCents: number, invoiceCents: number): number {
  if (balanceCents <= 0 || invoiceCents <= 0) return 0;
  const cap = Math.floor(invoiceCents * MAX_INVOICE_SHARE);
  return Math.min(balanceCents, cap);
}
