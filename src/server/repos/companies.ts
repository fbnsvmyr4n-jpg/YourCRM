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
