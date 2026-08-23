import type { TenantQuery } from "../tenant";

/**
 * Companies as a real entity, not a string on a contact.
 *
 * The company name lived in `contacts.info` — a piece of text repeated on every
 * person who works there. Two consequences, both of which the audit called out:
 *
 *  - **You cannot see every deal for one company.** The only way to group them
 *    is to match the text, and "Acme Ltd", "Acme Ltd." and "acme ltd" are three
 *    different companies to a string comparison.
 *  - **A rename silently breaks the link.** Correcting the spelling on one
 *    contact detaches them from their colleagues, with nothing to indicate it
 *    happened.
 *
 * The name is now a row, and contacts point at it. Renaming the row renames it
 * everywhere, because there is only one of it.
 */

export type CompanyRecord = {
  id: string;
  name: string;
  domain: string | null;
  info: string | null;
};

/** A company with what it is actually worth. */
export type CompanyRollup = CompanyRecord & {
  contacts: number;
  openDeals: number;
  openCents: number;
  wonCents: number;
};

type Row = {
  id: string;
  name: string;
  domain: string | null;
  info: string | null;
};

const toRecord = (r: Row): CompanyRecord => ({
  id: r.id,
  name: r.name,
  domain: r.domain,
  info: r.info,
});

function newId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 24) || "company";
  return `co-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function listCompanies(q: TenantQuery): Promise<CompanyRecord[]> {
  const rows = await q.rows<Row>(
    `SELECT id, name, domain, info FROM companies
     WHERE sub_account_id = $1 AND deleted_at IS NULL
     ORDER BY name ASC`,
    [q.ctx.subAccountId]
  );
  return rows.map(toRecord);
}

/**
 * Find a company by name, or create it.
 *
 * Matched case-insensitively on the trimmed name, because "Acme Ltd" typed by
 * one person and "acme ltd" by another are the same company — and an import
 * that creates both produces exactly the mess this entity exists to prevent.
 *
 * The first spelling wins. Overwriting it with each new variant would mean the
 * company's name changed depending on who was added last.
 */
export async function findOrCreateCompany(
  q: TenantQuery,
  name: string
): Promise<CompanyRecord | null> {
  const label = name.trim();
  if (!label) return null;

  const existing = await q.one<Row>(
    `SELECT id, name, domain, info FROM companies
     WHERE sub_account_id = $1 AND deleted_at IS NULL
       AND lower(name) = lower($2)
     LIMIT 1`,
    [q.ctx.subAccountId, label]
  );
  if (existing) return toRecord(existing);

  const row = await q.one<Row>(
    `INSERT INTO companies (id, sub_account_id, name)
     VALUES ($2, $1, $3)
     RETURNING id, name, domain, info`,
    [q.ctx.subAccountId, newId(label), label]
  );
  return row ? toRecord(row) : null;
}

/** Rename a company. One row, so every contact and deal follows it. */
export async function renameCompany(
  q: TenantQuery,
  id: string,
  name: string
): Promise<CompanyRecord | null> {
  const label = name.trim();
  if (!label) return null;
  const row = await q.one<Row>(
    `UPDATE companies SET name = $3, updated_at = now()
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
     RETURNING id, name, domain, info`,
    [q.ctx.subAccountId, id, label]
  );
  return row ? toRecord(row) : null;
}

/**
 * Every company with its people and its money.
 *
 * This is the question that could not be asked before: what is this company
 * worth to us, across everyone who works there. Deals reach a company through
 * the contact they belong to, which is why the join goes through `contacts`
 * rather than expecting a company on the deal itself — a deal belongs to a
 * person, and the person belongs to a company.
 *
 * Won and open are separate for the same reason they are on the referral
 * report: a company with four dead deals is not a company with two live ones,
 * and one blended figure hides the difference.
 */
export async function companyRollups(q: TenantQuery): Promise<CompanyRollup[]> {
  const rows = await q.rows<
    Row & {
      contacts: string;
      open_deals: string;
      open_cents: string;
      won_cents: string;
    }
  >(
    `SELECT co.id, co.name, co.domain, co.info,
            count(DISTINCT c.id)::text AS contacts,
            count(DISTINCT d.id) FILTER (
              WHERE d.won_at IS NULL AND d.stage <> 'lost'
            )::text AS open_deals,
            COALESCE(sum(d.value_cents) FILTER (
              WHERE d.won_at IS NULL AND d.stage <> 'lost'
            ), 0)::text AS open_cents,
            COALESCE(sum(d.value_cents) FILTER (WHERE d.won_at IS NOT NULL), 0)::text AS won_cents
       FROM companies co
       -- LEFT, so a company with nobody at it yet still appears. Dropping it
       -- makes a company vanish the moment its only contact is removed, which
       -- reads as the company having been deleted.
       LEFT JOIN contacts c
              ON c.company_id = co.id
             AND c.sub_account_id = $1
             AND c.deleted_at IS NULL
       LEFT JOIN deals d
              ON d.contact_id = c.id
             AND d.sub_account_id = $1
             AND d.deleted_at IS NULL
      WHERE co.sub_account_id = $1
        AND co.deleted_at IS NULL
      GROUP BY co.id, co.name, co.domain, co.info
      ORDER BY sum(d.value_cents) FILTER (WHERE d.won_at IS NOT NULL) DESC NULLS LAST,
               count(DISTINCT c.id) DESC, co.name ASC`,
    [q.ctx.subAccountId]
  );

  return rows.map((r) => ({
    ...toRecord(r),
    contacts: Number(r.contacts),
    openDeals: Number(r.open_deals),
    openCents: Number(r.open_cents),
    wonCents: Number(r.won_cents),
  }));
}

/**
 * Remove a company.
 *
 * Soft, like everything else here. The contacts stay exactly where they are —
 * they simply stop showing a company, and the original text on each of them is
 * untouched. That matters because the first thing anybody does with this screen
 * is clear out rows that were never companies, and a hard delete would make
 * "I removed the wrong one" unrecoverable.
 *
 * The link on each contact is cleared too. Leaving it pointing at a removed row
 * means restoring the company silently re-attaches people who may since have
 * been moved somewhere else.
 */
export async function removeCompany(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE companies SET deleted_at = now(), updated_at = now()
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
     RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  if (!row) return false;

  await q.rows(
    `UPDATE contacts SET company_id = NULL, updated_at = now()
     WHERE company_id = $2 AND sub_account_id = $1 AND deleted_at IS NULL`,
    [q.ctx.subAccountId, id]
  );
  return true;
}

/**
 * Put a removed company back.
 *
 * It returns EMPTY, and that is a decision rather than an omission. Removing it
 * cleared `company_id` on everyone who belonged to it — see the note above — so
 * nothing records who the members were, and re-attaching by guesswork would be
 * worse than an honest empty company. The screen says this before you restore.
 */
export async function restoreCompany(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE companies SET deleted_at = NULL, updated_at = now()
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NOT NULL
     RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return row !== null;
}

export type CompanyPerson = {
  id: string;
  name: string;
  email: string | null;
  deals: number;
  wonCents: number;
};

export type CompanyDeal = {
  id: string;
  title: string;
  stage: string;
  valueCents: number;
  wonAt: string | null;
  contactName: string;
};

/** One company, with everyone at it and every deal they are on. */
export async function companyDetail(
  q: TenantQuery,
  id: string
): Promise<{ people: CompanyPerson[]; deals: CompanyDeal[] } | null> {
  const company = await q.one<{ id: string }>(
    `SELECT id FROM companies
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL`,
    [q.ctx.subAccountId, id]
  );
  if (!company) return null;

  const people = await q.rows<{
    id: string;
    name: string;
    email: string | null;
    deals: string;
    won_cents: string;
  }>(
    `SELECT c.id,
            btrim(c.first_name || ' ' || c.last_name) AS name,
            c.email,
            count(d.id)::text AS deals,
            COALESCE(sum(d.value_cents) FILTER (WHERE d.won_at IS NOT NULL), 0)::text AS won_cents
       FROM contacts c
       LEFT JOIN deals d
              ON d.contact_id = c.id
             AND d.sub_account_id = $1
             AND d.deleted_at IS NULL
      WHERE c.company_id = $2
        AND c.sub_account_id = $1
        AND c.deleted_at IS NULL
      GROUP BY c.id, c.first_name, c.last_name, c.email
      ORDER BY sum(d.value_cents) FILTER (WHERE d.won_at IS NOT NULL) DESC NULLS LAST, name ASC`,
    [q.ctx.subAccountId, id]
  );

  const deals = await q.rows<{
    id: string;
    title: string;
    stage: string;
    value_cents: string;
    won_at: Date | null;
    contact_name: string;
  }>(
    `SELECT d.id, d.title, d.stage, d.value_cents::text, d.won_at,
            btrim(c.first_name || ' ' || c.last_name) AS contact_name
       FROM deals d
       JOIN contacts c
         ON c.id = d.contact_id
        AND c.sub_account_id = $1
        AND c.deleted_at IS NULL
      WHERE c.company_id = $2
        AND d.sub_account_id = $1
        AND d.deleted_at IS NULL
      ORDER BY d.won_at DESC NULLS FIRST, d.value_cents DESC`,
    [q.ctx.subAccountId, id]
  );

  return {
    people: people.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      deals: Number(r.deals),
      wonCents: Number(r.won_cents),
    })),
    deals: deals.map((r) => ({
      id: r.id,
      title: r.title,
      stage: r.stage,
      valueCents: Number(r.value_cents),
      wonAt: r.won_at ? r.won_at.toISOString() : null,
      contactName: r.contact_name,
    })),
  };
}
