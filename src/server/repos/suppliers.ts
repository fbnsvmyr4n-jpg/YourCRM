import { randomBytes } from "node:crypto";
import type { TenantQuery } from "../tenant";
import type { ParsedLine } from "../price-import";
/* Declared in `data/` rather than here, because the inbox card that reads it is
   a client component and this module imports `node:crypto`. See that file. */
import type { PriceListLoad } from "@/data/price-loads";

/**
 * Who the workspace buys from, and loading what they charge.
 *
 * The price list used to be a flat list somebody typed. It is really a set of
 * SUPPLIERS' lists — the merchant sets the rate for stone, it moves, and a
 * quotation built on an old figure loses money on every square metre. This is
 * the half of that which touches the database; `server/price-import.ts` holds
 * the reading and the diff, which are pure and tested on their own.
 */

export type Supplier = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  /** The day their list was last loaded, or null if it never has been. */
  listUpdatedOn: string | null;
  /** How many live price items came from them. */
  itemCount: number;
  /**
   * Load their emailed lists without asking, when there is nothing worth
   * looking at. Per supplier, because trust is per supplier: the merchant who
   * has sent the same clean spreadsheet monthly for two years is not the one
   * who sends a photograph of a fax.
   *
   * It does not mean "apply anything they send" — see `unattendedVerdict`.
   */
  autoLoad: boolean;
};

type Row = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  list_updated_on: string | null;
  item_count: string;
  auto_load: boolean;
};

const toSupplier = (r: Row): Supplier => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  notes: r.notes,
  listUpdatedOn: r.list_updated_on,
  itemCount: Number(r.item_count),
  autoLoad: r.auto_load,
});

export async function listSuppliers(q: TenantQuery): Promise<Supplier[]> {
  const rows = await q.rows<Row>(
    `SELECT s.id, s.name, s.email, s.phone, s.notes, s.auto_load,
            s.list_updated_on::text AS list_updated_on,
            COUNT(p.id) FILTER (WHERE p.deleted_at IS NULL)::text AS item_count
       FROM suppliers s
       LEFT JOIN price_items p
         ON p.supplier_id = s.id AND p.sub_account_id = s.sub_account_id
      WHERE s.sub_account_id = $1 AND s.deleted_at IS NULL
      GROUP BY s.id
      ORDER BY lower(s.name)`,
    [q.ctx.subAccountId]
  );
  return rows.map(toSupplier);
}

export async function createSupplier(
  q: TenantQuery,
  input: {
    name: string;
    email?: string | null;
    phone?: string | null;
    notes?: string | null;
    autoLoad?: boolean;
  }
): Promise<Supplier | null> {
  const name = input.name.trim();
  if (!name) return null;

  const rows = await q.rows<Row>(
    `INSERT INTO suppliers (id, sub_account_id, name, email, phone, notes, auto_load)
     VALUES ($2, $1, $3, $4, $5, $6, $7)
     RETURNING id, name, email, phone, notes, auto_load,
               list_updated_on::text AS list_updated_on, '0' AS item_count`,
    [
      q.ctx.subAccountId,
      `sup-${randomBytes(9).toString("hex")}`,
      name.slice(0, 120),
      input.email?.trim() || null,
      input.phone?.trim() || null,
      input.notes?.trim() || null,
      input.autoLoad ?? false,
    ]
  );
  return rows.length ? toSupplier(rows[0]) : null;
}

export async function updateSupplier(
  q: TenantQuery,
  id: string,
  input: {
    name: string;
    email?: string | null;
    phone?: string | null;
    notes?: string | null;
    autoLoad?: boolean;
  }
): Promise<boolean> {
  const name = input.name.trim();
  if (!name) return false;
  const rows = await q.rows<{ id: string }>(
    `UPDATE suppliers
        SET name = $3, email = $4, phone = $5, notes = $6, auto_load = $7, updated_at = now()
      WHERE sub_account_id = $1 AND id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [
      q.ctx.subAccountId,
      id,
      name.slice(0, 120),
      input.email?.trim() || null,
      input.phone?.trim() || null,
      input.notes?.trim() || null,
      input.autoLoad ?? false,
    ]
  );
  return rows.length > 0;
}

/**
 * Remove a supplier without removing what they priced.
 *
 * Soft, and the prices stay. A quotation sent last month cites a rate; deleting
 * the merchant must not delete the rate it was built from or that document can
 * no longer be explained. The items simply stop naming a supplier — which is
 * the same state as everything typed before suppliers existed, so it is a state
 * the screens already handle.
 */
export async function deleteSupplier(q: TenantQuery, id: string): Promise<boolean> {
  const rows = await q.rows<{ id: string }>(
    `UPDATE suppliers SET deleted_at = now(), updated_at = now()
      WHERE sub_account_id = $1 AND id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  if (rows.length === 0) return false;
  await q.rows(
    `UPDATE price_items SET supplier_id = NULL, updated_at = now()
      WHERE sub_account_id = $1 AND supplier_id = $2`,
    [q.ctx.subAccountId, id]
  );
  return true;
}

/** Everything this supplier currently prices, for diffing a pasted list against. */
export async function supplierItems(
  q: TenantQuery,
  supplierId: string
): Promise<{ id: string; name: string; unitCents: number }[]> {
  const rows = await q.rows<{ id: string; name: string; unit_cents: string }>(
    `SELECT id, name, unit_cents::text
       FROM price_items
      WHERE sub_account_id = $1 AND supplier_id = $2 AND deleted_at IS NULL`,
    [q.ctx.subAccountId, supplierId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, unitCents: Number(r.unit_cents) }));
}

/**
 * What every auto-loading supplier currently prices, in ONE query.
 *
 * For the inbox, which has to explain why a list was held back and needs the
 * prices on file to work that out. One query rather than one per supplier
 * because this runs on a screen that draws fifty rows, and only for the
 * suppliers whose lists load themselves — for everybody else there is nothing
 * to explain, because nothing was expected.
 */
export async function itemsForAutoLoadSuppliers(
  q: TenantQuery
): Promise<Record<string, { id: string; name: string; unitCents: number }[]>> {
  const rows = await q.rows<{
    supplier_id: string;
    id: string;
    name: string;
    unit_cents: string;
  }>(
    `SELECT p.supplier_id, p.id, p.name, p.unit_cents::text
       FROM price_items p
       JOIN suppliers s
         ON s.id = p.supplier_id AND s.sub_account_id = p.sub_account_id
      WHERE p.sub_account_id = $1
        AND p.deleted_at IS NULL
        AND s.deleted_at IS NULL
        AND s.auto_load`,
    [q.ctx.subAccountId]
  );

  const out: Record<string, { id: string; name: string; unitCents: number }[]> = {};
  for (const r of rows) {
    (out[r.supplier_id] ??= []).push({
      id: r.id,
      name: r.name,
      unitCents: Number(r.unit_cents),
    });
  }
  return out;
}

export type ApplyResult = { added: number; repriced: number; unchanged: number };

/**
 * Write a read price list against its supplier.
 *
 * Matching happens in `planChanges`, which is pure and tested; this applies
 * what it decided. One statement per row rather than a clever bulk upsert,
 * because the thing that matters here is being able to say exactly what
 * changed, and forty statements inside one transaction is not a performance
 * problem a contractor will ever notice.
 *
 * What it deliberately does NOT do is withdraw items missing from the new list.
 * A supplier sending their paving sheet is not saying they stopped selling
 * sand, and a parser that reads 38 of 40 rows would quietly withdraw the two it
 * failed on. Withdrawing stays a thing a person does on purpose.
 */
export async function applyPriceList(
  q: TenantQuery,
  supplierId: string,
  changes: { kind: "new" | "changed" | "same"; id?: string; line: ParsedLine }[],
  today: string
): Promise<ApplyResult> {
  const result: ApplyResult = { added: 0, repriced: 0, unchanged: 0 };

  for (const change of changes) {
    if (change.kind === "same") {
      result.unchanged += 1;
      continue;
    }
    if (change.kind === "changed" && change.id) {
      const rows = await q.rows<{ id: string }>(
        `UPDATE price_items
            SET unit_cents = $4, unit = $5, updated_at = now()
          WHERE sub_account_id = $1 AND id = $2 AND supplier_id = $3 AND deleted_at IS NULL
          RETURNING id`,
        [q.ctx.subAccountId, change.id, supplierId, change.line.unitCents, change.line.unit]
      );
      if (rows.length) result.repriced += 1;
      continue;
    }
    await q.rows(
      `INSERT INTO price_items (id, sub_account_id, supplier_id, name, unit, unit_cents, active)
       VALUES ($2, $1, $3, $4, $5, $6, TRUE)`,
      [
        q.ctx.subAccountId,
        `pi-${randomBytes(9).toString("hex")}`,
        supplierId,
        change.line.name.slice(0, 120),
        change.line.unit.slice(0, 24),
        change.line.unitCents,
      ]
    );
    result.added += 1;
  }

  /* Stamped even when nothing moved: "we checked their list on the 4th and it
     had not changed" is a different and more useful fact than silence. */
  await q.rows(
    `UPDATE suppliers SET list_updated_on = $3::date, updated_at = now()
      WHERE sub_account_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [q.ctx.subAccountId, supplierId, today]
  );

  return result;
}

/* ------------------------------------------------------------------ */
/* The record of a load                                                */
/*                                                                     */
/* `PriceListLoad` itself is declared in `data/price-loads.ts`: the     */
/* inbox card that renders one is a client component, and importing a  */
/* type from this module pulls `node:crypto` into the browser bundle.  */
/* ------------------------------------------------------------------ */

export type { PriceListLoad };

/**
 * Write down that a list was loaded, and what it did.
 *
 * Both paths record — the paste and the automatic one. A log that only covers
 * the unattended case would answer "did the machine do this" and not "who did",
 * and the second question is the one asked when a figure looks wrong.
 *
 * Returns false when this message has already been loaded. That is not an
 * error: the unique index is what makes loading idempotent, so a double press,
 * a re-render, or two tabs open all mean one load. The caller checks it rather
 * than being thrown at, because "already done" and "failed" must not look the
 * same to the screen.
 */
export async function recordLoad(
  q: TenantQuery,
  input: {
    supplierId: string;
    messageId: string | null;
    /** Null for an automatic load. */
    userId: string | null;
    result: ApplyResult;
  }
): Promise<boolean> {
  const rows = await q.rows<{ id: string }>(
    `INSERT INTO price_list_loads
       (id, sub_account_id, supplier_id, message_id, loaded_by_user_id, added, repriced, unchanged)
     VALUES ($2, $1, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      q.ctx.subAccountId,
      `pll-${randomBytes(9).toString("hex")}`,
      input.supplierId,
      input.messageId,
      input.userId,
      input.result.added,
      input.result.repriced,
      input.result.unchanged,
    ]
  );
  return rows.length > 0;
}

/**
 * Which messages have already had their list loaded, keyed by message.
 *
 * Read by the inbox so a message that has been loaded stops offering to load
 * itself. One query for the screen rather than one per message: an inbox draws
 * fifty rows, and fifty round trips to answer "has this one been done" is the
 * kind of thing that makes a list feel slow for a fact that is almost always
 * "no".
 */
export async function loadsByMessage(
  q: TenantQuery,
  limit = 200
): Promise<Record<string, PriceListLoad>> {
  const rows = await q.rows<{
    id: string;
    supplier_id: string;
    supplier_name: string;
    message_id: string;
    loaded_by_user_id: string | null;
    loaded_by_name: string | null;
    added: number;
    repriced: number;
    unchanged: number;
    loaded_at: string;
  }>(
    `SELECT l.id, l.supplier_id, s.name AS supplier_name, l.message_id,
            l.loaded_by_user_id, u.name AS loaded_by_name,
            l.added, l.repriced, l.unchanged, l.loaded_at
       FROM price_list_loads l
       JOIN suppliers s ON s.id = l.supplier_id AND s.sub_account_id = l.sub_account_id
       LEFT JOIN users u ON u.id = l.loaded_by_user_id
      WHERE l.sub_account_id = $1 AND l.message_id IS NOT NULL
      ORDER BY l.loaded_at DESC
      LIMIT $2`,
    [q.ctx.subAccountId, limit]
  );

  const out: Record<string, PriceListLoad> = {};
  for (const r of rows) {
    out[r.message_id] = {
      id: r.id,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      messageId: r.message_id,
      loadedByUserId: r.loaded_by_user_id,
      loadedByName: r.loaded_by_name,
      added: r.added,
      repriced: r.repriced,
      unchanged: r.unchanged,
      loadedAt: r.loaded_at,
    };
  }
  return out;
}

/** Has this message's list already been loaded, and what did it do? */
export async function loadForMessage(
  q: TenantQuery,
  messageId: string
): Promise<PriceListLoad | null> {
  const row = await q.one<{
    id: string;
    supplier_id: string;
    supplier_name: string;
    message_id: string | null;
    loaded_by_user_id: string | null;
    loaded_by_name: string | null;
    added: number;
    repriced: number;
    unchanged: number;
    loaded_at: string;
  }>(
    `SELECT l.id, l.supplier_id, s.name AS supplier_name, l.message_id,
            l.loaded_by_user_id, u.name AS loaded_by_name,
            l.added, l.repriced, l.unchanged, l.loaded_at
       FROM price_list_loads l
       JOIN suppliers s ON s.id = l.supplier_id AND s.sub_account_id = l.sub_account_id
       LEFT JOIN users u ON u.id = l.loaded_by_user_id
      WHERE l.sub_account_id = $1 AND l.message_id = $2`,
    [q.ctx.subAccountId, messageId]
  );
  if (!row) return null;
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    messageId: row.message_id,
    loadedByUserId: row.loaded_by_user_id,
    loadedByName: row.loaded_by_name,
    added: row.added,
    repriced: row.repriced,
    unchanged: row.unchanged,
    loadedAt: row.loaded_at,
  };
}
