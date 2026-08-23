import type { TenantQuery } from "../tenant";

/**
 * Contacts, on real SQL.
 *
 * Three rules this module exists to hold, each of them a defect the audit found
 * in the version it replaces:
 *
 *  0. Every statement filters `sub_account_id` itself, AND row-level security
 *     enforces the same thing underneath. Two controls, deliberately: RLS is
 *     bypassed by any superuser or BYPASSRLS connection — a Neon admin session,
 *     a migration script, a future read-replica user — so a repo trusting it
 *     alone leaks completely the moment anything connects differently. The
 *     "remembering to filter" problem is answered by a test that checks every
 *     query for the predicate, not by leaving the predicate out.
 *  1. It never reaches for storage itself. It is handed a tenant-scoped
 *     querier, so it cannot run outside a tenant — that is a type error, not a
 *     thing to remember. The old repo called `readTable`/`mutateTable` directly
 *     and had no concept of who was asking.
 *  2. It stores no sales position. Whether someone is a lead or a client is
 *     computed from their deals at read time. A stored `status` is what went
 *     stale before, and `type` was a second copy of the same claim that could
 *     disagree with it.
 *  3. Deletion is soft, and every read filters the tombstone. Hard deletes on
 *     real customer data with no undo were the audit's second-highest risk.
 *
 * The whole table is never loaded to answer a question about one row; that was
 * the JSONB path's defining cost.
 */

/** What a contact *is*: a person. Their sales position is derived, below. */
export type ContactRecord = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  companyId: string | null;
  /** Read from the company row; null when the contact has no company. */
  companyName: string | null;
  info: string | null;
  location: string | null;
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Derived: has at least one deal that was won. Never stored. */
  isClient: boolean;
  /** Derived: has a deal still in play. This is what "a lead" now means. */
  hasOpenDeal: boolean;
};

export type NewContact = {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  companyId?: string | null;
  info?: string | null;
  location?: string | null;
  /** Set from the session by the caller; never trusted from a form. */
  ownerUserId?: string | null;
};

type Row = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  company_id: string | null;
  company_name: string | null;
  info: string | null;
  location: string | null;
  owner_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  is_client: boolean;
  has_open_deal: boolean;
};

/**
 * `won_at` rather than the stage is the client signal: it records the fact that
 * payment happened, and survives the deal moving on to Delivery or Referral.
 * Reading the stage instead would make a client stop being one the moment their
 * deal advanced past "won".
 *
 * "Open" is the three pre-close stages. Delivery and Referral are post-close
 * and belong to a client, not a lead; `lost` is terminal.
 */
const SELECT = `
  SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.company_id,
         -- The company real name, from the row it points at. The old text
         -- column is kept only as a fallback, for contacts that predate the
         -- backfill or genuinely have no company.
         co.name AS company_name,
         c.info, c.location, c.owner_user_id, c.created_at, c.updated_at,
         EXISTS (
           SELECT 1 FROM deals d
           WHERE d.contact_id = c.id AND d.won_at IS NOT NULL AND d.deleted_at IS NULL
         ) AS is_client,
         EXISTS (
           SELECT 1 FROM deals d
           WHERE d.contact_id = c.id AND d.deleted_at IS NULL
             AND d.stage IN ('prospect', 'discovery', 'demo')
         ) AS has_open_deal
  FROM contacts c
  LEFT JOIN companies co
         ON co.id = c.company_id
        AND co.sub_account_id = c.sub_account_id
        AND co.deleted_at IS NULL
  WHERE c.deleted_at IS NULL AND c.sub_account_id = $1`;

function toRecord(r: Row): ContactRecord {
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    companyId: r.company_id,
    companyName: r.company_name,
    info: r.info,
    location: r.location,
    ownerUserId: r.owner_user_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    isClient: r.is_client,
    hasOpenDeal: r.has_open_deal,
  };
}

function newId(first: string, last: string): string {
  const base = `${first}-${last}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `${base || "contact"}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function listContacts(q: TenantQuery): Promise<ContactRecord[]> {
  const rows = await q.rows<Row>(`${SELECT} ORDER BY c.created_at DESC, c.id`, [q.ctx.subAccountId]);
  return rows.map(toRecord);
}

export async function getContact(q: TenantQuery, id: string): Promise<ContactRecord | null> {
  const row = await q.one<Row>(`${SELECT} AND c.id = $2`, [q.ctx.subAccountId, id]);
  return row ? toRecord(row) : null;
}

export async function createContact(q: TenantQuery, input: NewContact): Promise<ContactRecord> {
  const first = input.firstName.trim();
  const last = input.lastName.trim();

  // sub_account_id comes from the context, never from the caller's input. The
  // row-level WITH CHECK would refuse a foreign tenant anyway; this makes it
  // impossible to attempt rather than merely impossible to succeed.
  const row = await q.one<Row>(
    `WITH inserted AS (
       INSERT INTO contacts
         (id, sub_account_id, owner_user_id, first_name, last_name, email, phone,
          company_id, info, location)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *
     )
     ${SELECT.replace("FROM contacts c", "FROM inserted c").replace("$1", "$2")}`,
    [
      newId(first, last),
      q.ctx.subAccountId,
      input.ownerUserId ?? null,
      first,
      last,
      input.email?.trim() || null,
      input.phone?.trim() || null,
      input.companyId ?? null,
      input.info?.trim() || null,
      input.location?.trim() || null,
    ]
  );
  if (!row) throw new Error("Contact was not created.");
  return toRecord(row);
}

export async function updateContact(
  q: TenantQuery,
  id: string,
  patch: Partial<NewContact>
): Promise<ContactRecord | null> {
  // COALESCE per column: an omitted field keeps its stored value, so a partial
  // update cannot blank the fields it did not mention. Clearing a field is done
  // by passing null explicitly, which the `=== undefined` checks below preserve.
  const row = await q.one<Row>(
    `WITH updated AS (
       UPDATE contacts SET
         first_name  = COALESCE($2, first_name),
         last_name   = COALESCE($3, last_name),
         email       = CASE WHEN $4::boolean THEN $5 ELSE email END,
         phone       = CASE WHEN $6::boolean THEN $7 ELSE phone END,
         company_id  = CASE WHEN $8::boolean THEN $9 ELSE company_id END,
         info        = CASE WHEN $10::boolean THEN $11 ELSE info END,
         location    = CASE WHEN $12::boolean THEN $13 ELSE location END,
         owner_user_id = CASE WHEN $14::boolean THEN $15 ELSE owner_user_id END,
         updated_at  = now()
       WHERE id = $1 AND sub_account_id = $16 AND deleted_at IS NULL
       RETURNING *
     )
     ${SELECT.replace("FROM contacts c", "FROM updated c").replace("$1", "$16")}`,
    [
      id,
      patch.firstName?.trim() ?? null,
      patch.lastName?.trim() ?? null,
      patch.email !== undefined,
      patch.email?.trim() ?? null,
      patch.phone !== undefined,
      patch.phone?.trim() ?? null,
      patch.companyId !== undefined,
      patch.companyId ?? null,
      patch.info !== undefined,
      patch.info?.trim() ?? null,
      patch.location !== undefined,
      patch.location?.trim() ?? null,
      patch.ownerUserId !== undefined,
      patch.ownerUserId ?? null,
      q.ctx.subAccountId,
    ]
  );
  return row ? toRecord(row) : null;
}

/**
 * Soft delete. The row stops being readable everywhere at once because every
 * read in this module filters `deleted_at IS NULL`, and it remains recoverable.
 *
 * Nothing cascades by hand: the contact's deals keep their history and simply
 * lose the link (`ON DELETE SET NULL` covers the hard case). The old repo
 * deleted the activity rows itself, in a second lock, after the fact.
 */
export async function deleteContact(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE contacts SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND sub_account_id = $2 AND deleted_at IS NULL RETURNING id`,
    [id, q.ctx.subAccountId]
  );
  return row !== null;
}

/**
 * The most rows one bulk action may touch.
 *
 * Not a performance limit — the statements below are single queries. It is a
 * blast radius: a mis-click on "select all" after importing five hundred
 * contacts should not be able to delete an entire book of business in one
 * request, and a cap means the mistake is partial and obvious rather than total
 * and silent.
 */
export const BULK_LIMIT = 500;

/**
 * Bulk operations, as one statement each.
 *
 * `= ANY($2)` rather than a loop: five hundred contacts is five hundred round
 * trips otherwise, and — far worse — a failure halfway leaves half the
 * selection changed with nothing to say which half. One statement is atomic.
 *
 * Every one filters `sub_account_id` itself. The ids arrive from a browser, so
 * an id from another workspace simply matches nothing rather than being acted
 * on; the count that comes back is the count that was actually changed, which
 * is what the caller reports.
 */
export async function bulkAssignOwner(
  q: TenantQuery,
  ids: string[],
  ownerUserId: string | null
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await q.rows<{ id: string }>(
    `UPDATE contacts SET owner_user_id = $3, updated_at = now()
     WHERE id = ANY($2) AND sub_account_id = $1 AND deleted_at IS NULL
     RETURNING id`,
    [q.ctx.subAccountId, ids.slice(0, BULK_LIMIT), ownerUserId]
  );
  return rows.length;
}

export async function bulkSetCompany(
  q: TenantQuery,
  ids: string[],
  companyId: string | null
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await q.rows<{ id: string }>(
    `UPDATE contacts SET company_id = $3, updated_at = now()
     WHERE id = ANY($2) AND sub_account_id = $1 AND deleted_at IS NULL
       -- A company from another workspace matches nothing here, so the whole
       -- statement changes no rows rather than moving people into a stranger's
       -- account.
       AND ($3::text IS NULL OR EXISTS (
         SELECT 1 FROM companies co
         WHERE co.id = $3 AND co.sub_account_id = $1 AND co.deleted_at IS NULL
       ))
     RETURNING id`,
    [q.ctx.subAccountId, ids.slice(0, BULK_LIMIT), companyId]
  );
  return rows.length;
}

export async function bulkDeleteContacts(q: TenantQuery, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  // Soft, like every delete here. The audit found a record destroyed and only
  // partly reconstructed because there was nothing to restore from.
  const rows = await q.rows<{ id: string }>(
    `UPDATE contacts SET deleted_at = now(), updated_at = now()
     WHERE id = ANY($2) AND sub_account_id = $1 AND deleted_at IS NULL
     RETURNING id`,
    [q.ctx.subAccountId, ids.slice(0, BULK_LIMIT)]
  );
  return rows.length;
}

export async function restoreContact(q: TenantQuery, id: string): Promise<boolean> {
  // The point of a tombstone. The audit found a record destroyed during it and
  // only partly reconstructed, because there was nothing to restore from.
  const row = await q.one<{ id: string }>(
    `UPDATE contacts SET deleted_at = NULL, updated_at = now()
     WHERE id = $1 AND sub_account_id = $2 AND deleted_at IS NOT NULL RETURNING id`,
    [id, q.ctx.subAccountId]
  );
  return row !== null;
}

/**
 * Assign, reassign or unassign the owner of this record.
 *
 * Separate from the general update for the same reason a stage change is: it
 * is a claim about who is responsible, not a form field, and it is the one
 * write the database refuses on grounds the caller cannot see from the row.
 *
 * A database trigger rejects an owner from another tenant — a plain foreign key
 * cannot express that, because the tenant is on this row and the agency is on
 * the user. The check runs there rather than only here so an import script or a
 * future endpoint cannot skip it. This turns its error into a readable one;
 * it does not replace it.
 *
 * `null` unassigns, which is always allowed.
 */
export async function assignOwner(
  q: TenantQuery,
  id: string,
  ownerUserId: string | null
): Promise<{ record?: ContactRecord; error?: string }> {
  try {
    const row = await q.one<Row>(
      `WITH updated AS (
         UPDATE contacts SET owner_user_id = $3
         WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
         RETURNING *
       )
       ${SELECT.replace("FROM contacts c", "FROM updated c").replace("$1", "$1")}`,
      [q.ctx.subAccountId, id, ownerUserId]
    );
    return row ? { record: toRecord(row) } : { error: "That record no longer exists." };
  } catch (err) {
    if (String(err).includes("does not belong to sub-account")) {
      return { error: "That person is not a member of this account." };
    }
    throw err;
  }
}

/** Everything assigned to one person — or, with null, everything unassigned. */
export async function listByOwner(
  q: TenantQuery,
  ownerUserId: string | null
): Promise<ContactRecord[]> {
  const rows = await q.rows<Row>(
    `${SELECT} AND c.owner_user_id IS NOT DISTINCT FROM $2`,
    [q.ctx.subAccountId, ownerUserId]
  );
  return rows.map(toRecord);
}

