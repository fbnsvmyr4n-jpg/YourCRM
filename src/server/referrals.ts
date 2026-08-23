import { logActivity } from "./repos/activity";
import { createContact } from "./repos/contacts";
import { createDeal, type DealRecord } from "./repos/deals";
import type { TenantQuery } from "./tenant";

/**
 * Closing the loop: a happy customer names somebody, and that becomes a
 * Prospect attributed back to them.
 *
 * The Referral stage's exit condition is "Feeds back into Prospect", and until
 * now nothing made that happen — the cycle ran in somebody's head, or more
 * usually did not run at all. Asking a delighted client who else has the same
 * problem is the cheapest pipeline there is, and it is the step everybody
 * intends to do and forgets.
 *
 * Two things are created together and must not half-exist: the person, and the
 * opportunity. A contact with no deal is a name nobody follows up; a deal with
 * no contact is a card with nobody to call. Both are written in the caller's
 * transaction, so a failure leaves neither.
 *
 * The attribution is a foreign key to the referrer's contact record, not a note
 * saying "referred by Dave". A name in a text field cannot be counted, and the
 * whole point is to be able to say what a referrer has been worth.
 */

export type ReferralInput = {
  /** The contact doing the referring — the existing, happy customer. */
  referrerContactId: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  /** What the referrer said about them, kept as the first pain point. */
  note?: string | null;
};

export type ReferralResult =
  | { ok: true; deal: DealRecord; contactId: string }
  | { ok: false; error: string };

export async function recordReferral(
  q: TenantQuery,
  input: ReferralInput
): Promise<ReferralResult> {
  const first = input.firstName.trim();
  const last = input.lastName.trim();
  if (!first && !last) return { ok: false, error: "Give the person a name." };

  // The referrer must be a real contact in THIS workspace. The id arrives from
  // a form, so it is checked rather than trusted — an unchecked one would let a
  // referral be attributed to somebody in another agency's account.
  const referrer = await q.one<{ id: string; first_name: string; last_name: string }>(
    `SELECT id, first_name, last_name FROM contacts
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL`,
    [q.ctx.subAccountId, input.referrerContactId]
  );
  if (!referrer) return { ok: false, error: "That referrer is no longer on the account." };

  const contact = await createContact(q, {
    firstName: first,
    lastName: last,
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
    info: null,
  });

  const referrerName = `${referrer.first_name} ${referrer.last_name}`.trim();

  const deal = await createDeal(q, {
    contactId: contact.id,
    // Named for the person, not "Referral from Dave" — the card sits in
    // Prospect beside everything else, and a title that describes its origin
    // rather than its subject reads as a different kind of thing.
    title: `${first} ${last}`.trim() || "Referred prospect",
    valueCents: 0,
    stage: "prospect",
    source: "referral",
    referredByContactId: referrer.id,
    // What the referrer said is the closest thing to a pain point that exists
    // before Discovery, and it is exactly what to open the first call with.
    painPoints: input.note?.trim() ? [input.note.trim()] : [],
  });

  // Logged against BOTH records. On the new prospect it explains where they
  // came from; on the referrer it is the evidence that they have been sending
  // work, which is what any thank-you or reward is based on.
  await logActivity(q, {
    entityType: "deal",
    entityId: deal.id,
    kind: "note",
    title: `Referred by ${referrerName}`,
    detail: input.note?.trim() || undefined,
    actorUserId: q.ctx.userId,
  });
  await logActivity(q, {
    entityType: "contact",
    entityId: referrer.id,
    kind: "note",
    title: `Referred ${first} ${last}`.trim(),
    actorUserId: q.ctx.userId,
  });

  return { ok: true, deal, contactId: contact.id };
}

export type ReferralCredit = {
  contactId: string;
  name: string;
  referrals: number;
  won: number;
  wonCents: number;
  openCents: number;
};

/**
 * What each referrer has actually been worth.
 *
 * Counted from the foreign key, so it cannot drift from the deals it describes
 * — and every figure is traceable to specific rows rather than to somebody's
 * recollection of who sent what.
 *
 * Won and open are kept apart on purpose. A referrer who has sent five deals
 * that all went nowhere is not the same as one who sent two that closed, and a
 * single blended number would hide the difference precisely when it is being
 * used to decide who gets thanked.
 */
export async function referralCredits(q: TenantQuery): Promise<ReferralCredit[]> {
  const rows = await q.rows<{
    contact_id: string;
    name: string;
    referrals: string;
    won: string;
    won_cents: string;
    open_cents: string;
  }>(
    `SELECT c.id AS contact_id,
            trim(c.first_name || ' ' || c.last_name) AS name,
            count(*)::text AS referrals,
            count(*) FILTER (WHERE d.won_at IS NOT NULL)::text AS won,
            COALESCE(sum(d.value_cents) FILTER (WHERE d.won_at IS NOT NULL), 0)::text AS won_cents,
            -- Open excludes lost as well as won: a lost referral is neither
            -- money in hand nor money still coming, and counting it as pipeline
            -- would keep it in the total forever.
            COALESCE(sum(d.value_cents) FILTER (WHERE d.won_at IS NULL AND d.stage <> 'lost'), 0)::text AS open_cents
       FROM deals d
       JOIN contacts c ON c.id = d.referred_by_contact_id AND c.sub_account_id = $1
      WHERE d.sub_account_id = $1
        AND d.deleted_at IS NULL
        AND c.deleted_at IS NULL
        AND d.referred_by_contact_id IS NOT NULL
      GROUP BY c.id, c.first_name, c.last_name
      ORDER BY sum(d.value_cents) FILTER (WHERE d.won_at IS NOT NULL) DESC NULLS LAST,
               count(*) DESC`,
    [q.ctx.subAccountId]
  );

  return rows.map((r) => ({
    contactId: r.contact_id,
    name: r.name,
    referrals: Number(r.referrals),
    won: Number(r.won),
    wonCents: Number(r.won_cents),
    openCents: Number(r.open_cents),
  }));
}
