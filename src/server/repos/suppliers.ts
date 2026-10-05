import { randomBytes } from "node:crypto";
import type { TenantQuery } from "../tenant";
import type { ParsedLine } from "../price-import";

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
};

type Row = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  list_updated_on: string | null;
  item_count: string;
};

const toSupplier = (r: Row): Supplier => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  notes: r.notes,
  listUpdatedOn: r.list_updated_on,
  itemCount: Number(r.item_count),
});

export async function listSuppliers(q: TenantQuery): Promise<Supplier[]> {
  const rows = await q.rows<Row>(
    `SELECT s.id, s.name, s.email, s.phone, s.notes,
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
  input: { name: string; email?: string | null; phone?: string | null; notes?: string | null }
): Promise<Supplier | null> {
  const name = input.name.trim();
  if (!name) return null;

  const rows = await q.rows<Row>(
    `INSERT INTO suppliers (id, sub_account_id, name, email, phone, notes)
     VALUES ($2, $1, $3, $4, $5, $6)
     RETURNING id, name, email, phone, notes, list_updated_on::text AS list_updated_on, '0' AS item_count`,
    [
      q.ctx.subAccountId,
      `sup-${randomBytes(9).toString("hex")}`,
      name.slice(0, 120),
      input.email?.trim() || null,
      input.phone?.trim() || null,
      input.notes?.trim() || null,
    ]
  );
  return rows.length ? toSupplier(rows[0]) : null;
}

export async function updateSupplier(
  q: TenantQuery,
  id: string,
  input: { name: string; email?: string | null; phone?: string | null; notes?: string | null }
): Promise<boolean> {
  const name = input.name.trim();
  if (!name) return false;
  const rows = await q.rows<{ id: string }>(
    `UPDATE suppliers
        SET name = $3, email = $4, phone = $5, notes = $6, updated_at = now()
      WHERE sub_account_id = $1 AND id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [
      q.ctx.subAccountId,
      id,
      name.slice(0, 120),
      input.email?.trim() || null,
      input.phone?.trim() || null,
      input.notes?.trim() || null,
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
