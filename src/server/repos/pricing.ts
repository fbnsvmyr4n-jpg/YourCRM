import type { TenantQuery } from "../tenant";

/**
 * What things cost.
 *
 * The list an agent draws a quotation from, and the reason it exists before any
 * agent does: an AI asked to quote a crane with no price list produces a number
 * that looks like a price and is not one. With a list, drafting is selection
 * rather than invention — pick the line, multiply by the quantity — and every
 * figure on a generated quote traces back to a row somebody here typed.
 *
 * It is equally the list a person picks from when writing a quote by hand, so
 * it earns its place whether or not the agent ever uses it.
 */

export type PriceItem = {
  id: string;
  name: string;
  description: string | null;
  /** Free text: "each", "per day", "per m²". Whatever this business sells by. */
  unit: string;
  unitCents: number;
  /** Withdrawn items stop being offered without breaking the quotes citing them. */
  active: boolean;
};

type Row = {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  unit_cents: string;
  active: boolean;
};

const toItem = (r: Row): PriceItem => ({
  id: r.id,
  name: r.name,
  description: r.description,
  unit: r.unit,
  unitCents: Number(r.unit_cents),
  active: r.active,
});

function newId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 24) || "item";
  return `pi-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * The whole list, active first.
 *
 * Withdrawn items are returned rather than filtered out — this is the screen
 * where somebody brings one back, and a list that silently omits them would
 * make that impossible. Callers that are OFFERING prices ask for `activeOnly`.
 */
export async function listPriceItems(q: TenantQuery, activeOnly = false): Promise<PriceItem[]> {
  const rows = await q.rows<Row>(
    `SELECT id, name, description, unit, unit_cents::text, active
       FROM price_items
      WHERE sub_account_id = $1 AND deleted_at IS NULL
        AND ($2::boolean IS NOT TRUE OR active)
      ORDER BY active DESC, lower(name)`,
    [q.ctx.subAccountId, activeOnly]
  );
  return rows.map(toItem);
}

export type SaveResult = { item?: PriceItem; error?: string };

/**
 * Add a price, or correct one.
 *
 * The unique index on the name is the actual guard; this turns its error into a
 * sentence. Two rows called "Crane hire" at different prices is a question the
 * agent cannot answer and a person should not have to.
 */
export async function savePriceItem(
  q: TenantQuery,
  input: {
    id?: string | null;
    name: string;
    description?: string | null;
    unit?: string | null;
    unitCents: number;
  }
): Promise<SaveResult> {
  const name = input.name.trim();
  if (!name) return { error: "Give the item a name." };
  if (!Number.isSafeInteger(input.unitCents) || input.unitCents < 0) {
    return { error: "The price must be a whole number of cents, and not negative." };
  }
  const unit = (input.unit ?? "").trim() || "each";
  const description = (input.description ?? "").trim() || null;

  try {
    const row = input.id
      ? await q.one<Row>(
          `UPDATE price_items
              SET name = $3, description = $4, unit = $5, unit_cents = $6, updated_at = now()
            WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
            RETURNING id, name, description, unit, unit_cents::text, active`,
          [q.ctx.subAccountId, input.id, name, description, unit, input.unitCents]
        )
      : await q.one<Row>(
          `INSERT INTO price_items (id, sub_account_id, name, description, unit, unit_cents)
           VALUES ($2, $1, $3, $4, $5, $6)
           RETURNING id, name, description, unit, unit_cents::text, active`,
          [q.ctx.subAccountId, newId(name), name, description, unit, input.unitCents]
        );
    return row ? { item: toItem(row) } : { error: "That item no longer exists." };
  } catch (err) {
    if (String(err).includes("price_items_name_once")) {
      return { error: `You already have an item called "${name}".` };
    }
    throw err;
  }
}

/**
 * Withdraw an item, or bring it back.
 *
 * Not a delete. A quotation that cited this line last year must keep making
 * sense, and the only way to guarantee that is to leave the row where it is.
 */
export async function setPriceItemActive(
  q: TenantQuery,
  id: string,
  active: boolean
): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE price_items SET active = $3, updated_at = now()
      WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [q.ctx.subAccountId, id, active]
  );
  return row !== null;
}

/** Remove one for good. For tidying a typo, not for withdrawing a service. */
export async function deletePriceItem(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE price_items SET deleted_at = now()
      WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return row !== null;
}
