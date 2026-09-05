import type { TenantQuery } from "./tenant";

/**
 * Whose client is whose.
 *
 * The question this answers is not "who are our customers" — Contacts already
 * does that — but "who is looking after them". On a five-person sales team that
 * is the thing nobody can see: two people ring the same company in a week, a
 * salesperson leaves and forty relationships have no name against them, and
 * neither is visible anywhere in the product until it goes wrong.
 *
 * Built on `contacts.owner_user_id`, which is already real and already
 * defended: a database trigger refuses an owner who belongs to another agency,
 * so a book of business cannot contain somebody else's employee.
 *
 * "Client" here means every contact assigned to that person, not only the ones
 * who have bought. A rep with ten live prospects and no closed deal yet has a
 * book, and a screen that showed them as empty would be describing the sale
 * rather than the relationship. The ones who HAVE bought are marked, and their
 * money is counted separately.
 */

/** One person's entry in somebody's book. */
export type BookEntry = {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  /** Has at least one won deal. Derived, never stored. */
  isClient: boolean;
  /** Has a deal still in play. */
  hasOpenDeal: boolean;
  /** Real money from deals actually won, in integer cents. */
  wonValueCents: number;
  openValueCents: number;
};

/** One owner and everything assigned to them. `owner` is null for unassigned. */
export type Book = {
  owner: { id: string; name: string; jobTitle: string | null; department: string | null } | null;
  entries: BookEntry[];
  clientCount: number;
  wonValueCents: number;
  openValueCents: number;
};

type Row = {
  id: string;
  owner_user_id: string | null;
  first_name: string;
  last_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  is_client: boolean;
  has_open_deal: boolean;
  won_cents: string;
  open_cents: string;
};

/**
 * Which pot a deal's money belongs in.
 *
 * Deliberately the same rule as `contact-summaries.ts`, and it has to stay that
 * way: a contact card saying R65,400 won while their owner's book says R0 is
 * the kind of disagreement that makes people stop trusting both screens. Won is
 * `won_at` OR a stage that means the sale happened — a deal dragged straight
 * from Demo to Delivery keeps a NULL `won_at`, which is exactly the case that
 * once left money counted in neither pot.
 */
const WON = `(d.won_at IS NOT NULL OR d.stage IN ('won', 'delivery', 'referral'))`;
const OPEN = `(d.won_at IS NULL AND d.stage IN ('prospect', 'discovery', 'demo'))`;

/**
 * Every contact in this workspace, with their owner and their money.
 *
 * One statement rather than a query per person. Called per owner it would
 * re-read the deals table once for every member of the team, and the screen
 * shows all of them at once.
 */
export async function clientBook(q: TenantQuery): Promise<Row[]> {
  return q.rows<Row>(
    `SELECT c.id, c.owner_user_id, c.first_name, c.last_name, c.email, c.phone,
            co.name AS company_name,
            COALESCE(SUM(d.value_cents) FILTER (WHERE ${WON}), 0)::text  AS won_cents,
            COALESCE(SUM(d.value_cents) FILTER (WHERE ${OPEN}), 0)::text AS open_cents,
            COUNT(d.id) FILTER (WHERE ${WON})  > 0 AS is_client,
            COUNT(d.id) FILTER (WHERE ${OPEN}) > 0 AS has_open_deal
       FROM contacts c
       LEFT JOIN companies co
              ON co.id = c.company_id
             AND co.sub_account_id = c.sub_account_id
             AND co.deleted_at IS NULL
       LEFT JOIN deals d
              ON d.contact_id = c.id
             AND d.deleted_at IS NULL
      WHERE c.deleted_at IS NULL AND c.sub_account_id = $1
      GROUP BY c.id, c.owner_user_id, c.first_name, c.last_name, c.email, c.phone, co.name
      ORDER BY lower(c.first_name), lower(c.last_name)`,
    [q.ctx.subAccountId]
  );
}

/** A person, as far as this screen is concerned. */
export type Owner = {
  id: string;
  name: string;
  jobTitle: string | null;
  department: string | null;
};

/**
 * Group the book by owner.
 *
 * Pure, and separated from the SQL so the ordering rules can be tested against
 * a fixture whose every answer is known by hand.
 *
 * Three rules, each for a reason:
 *
 *  - **The reader comes first.** The most common question at this screen is
 *    "what am I carrying", and scrolling to find your own name in a list of
 *    twelve is a small tax paid every single visit.
 *  - **Everybody is listed, including people with nothing.** A colleague with
 *    an empty book is a fact worth seeing — they are new, or they have just
 *    handed everything over — and hiding empty rows would make that invisible.
 *  - **Unassigned is last, and only when it has something in it.** Contacts
 *    with no owner are the actual problem this screen exists to surface, so
 *    they get a row of their own rather than being silently dropped.
 */
export function groupByOwner(rows: Row[], people: Owner[], readerId: string | null): Book[] {
  const byOwner = new Map<string | null, BookEntry[]>();
  for (const r of rows) {
    const entry: BookEntry = {
      id: r.id,
      name: `${r.first_name} ${r.last_name}`.trim(),
      company: r.company_name,
      email: r.email,
      phone: r.phone,
      isClient: r.is_client,
      hasOpenDeal: r.has_open_deal,
      wonValueCents: Number(r.won_cents),
      openValueCents: Number(r.open_cents),
    };
    /* Keyed on the owner as stored. An id belonging to somebody who has since
       been removed will not match anybody in `people`, and falls to the
       unassigned row below rather than vanishing. */
    const key = people.some((p) => p.id === r.owner_user_id) ? r.owner_user_id : null;
    const bucket = byOwner.get(key);
    if (bucket) bucket.push(entry);
    else byOwner.set(key, [entry]);
  }

  const totals = (entries: BookEntry[]) => ({
    entries,
    clientCount: entries.filter((e) => e.isClient).length,
    wonValueCents: entries.reduce((sum, e) => sum + e.wonValueCents, 0),
    openValueCents: entries.reduce((sum, e) => sum + e.openValueCents, 0),
  });

  const ordered = [...people].sort((a, b) => {
    if (a.id === readerId) return -1;
    if (b.id === readerId) return 1;
    return a.name.localeCompare(b.name);
  });

  const books: Book[] = ordered.map((owner) => ({
    owner,
    ...totals(byOwner.get(owner.id) ?? []),
  }));

  /* The key only exists once something has been put in it, so its presence IS
     "there is at least one unowned contact". The `length > 0` this used to also
     check could never be false — a guard that cannot fail reads as though it
     were the thing keeping the empty row out, and the next person to change
     this would trust it. */
  const unassigned = byOwner.get(null);
  if (unassigned) books.push({ owner: null, ...totals(unassigned) });
  return books;
}
