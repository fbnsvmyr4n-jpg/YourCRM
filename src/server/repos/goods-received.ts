import { randomBytes } from "node:crypto";
import type { TenantQuery } from "../tenant";
import { recordMovement } from "./stock";
/* Declared in `data/` because the card that renders one is a client component
   and this module imports `node:crypto`. See that file. */
import type { GoodsReceived, ReceivedLine } from "@/data/goods-received";

/**
 * The purchase slip: goods arriving from a supplier.
 *
 * The counterpart to a sale, and the half that makes the stock figure
 * trustworthy rather than a number that only ever goes down. An invoice takes
 * from the shelf; this is what puts back.
 *
 * ── Recording it IS the movement ──────────────────────────────────────────
 *
 * There is no separate "post this delivery" step. A slip somebody has typed
 * and not posted is a slip that will not be posted, and the shelf would be
 * short with the explanation sitting one screen away. Saving it moves the
 * stock, once per line, enforced by a unique index rather than hoped for.
 */

export type { GoodsReceived, ReceivedLine };

export type ReceiveResult = { id: string; moved: number } | { error: string };

/**
 * Record a delivery and put the goods on the shelf.
 *
 * Lines naming an item this workspace does not track are refused rather than
 * silently dropped: somebody typing a delivery expects every line of it to
 * count, and a line that quietly did nothing is a shelf that is short with no
 * sign of why.
 */
export async function receiveGoods(
  q: TenantQuery,
  input: {
    supplierId: string;
    reference: string | null;
    receivedOn: string;
    note: string | null;
    lines: { priceItemId: string; quantity: number }[];
    userId: string | null;
  }
): Promise<ReceiveResult> {
  const lines = input.lines.filter((l) => l.priceItemId && Number.isFinite(l.quantity) && l.quantity > 0);
  if (lines.length === 0) return { error: "Add at least one line, so the delivery records something." };

  const supplier = await q.one<{ id: string; name: string }>(
    `SELECT id, name FROM suppliers
      WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL`,
    [q.ctx.subAccountId, input.supplierId]
  );
  if (!supplier) return { error: "That supplier no longer exists." };

  /* Checked before anything is written, so a delivery is recorded whole or not
     at all. Half a delivery on the shelf is worse than none: the figure is
     wrong and the slip says it is right. */
  const ids = [...new Set(lines.map((l) => l.priceItemId))];
  const tracked = await q.rows<{ id: string; name: string }>(
    `SELECT id, name FROM price_items
      WHERE sub_account_id = $1 AND id = ANY($2::text[]) AND deleted_at IS NULL AND track_stock`,
    [q.ctx.subAccountId, ids]
  );
  if (tracked.length !== ids.length) {
    return {
      error:
        "Every line has to be something you hold as stock. Tick “I hold this as stock” on the item, or take the line off.",
    };
  }

  const id = `gr-${randomBytes(9).toString("hex")}`;
  await q.rows(
    `INSERT INTO goods_received
       (id, sub_account_id, supplier_id, reference, received_on, note, received_by_user_id)
     VALUES ($2, $1, $3, $4, $5::date, $6, $7)`,
    [
      q.ctx.subAccountId,
      id,
      input.supplierId,
      input.reference?.trim() || null,
      input.receivedOn,
      input.note?.trim() || null,
      input.userId,
    ]
  );

  let moved = 0;
  for (const [position, line] of lines.entries()) {
    const lineId = `grl-${randomBytes(9).toString("hex")}`;
    await q.rows(
      `INSERT INTO goods_received_lines
         (id, sub_account_id, goods_received_id, price_item_id, quantity, position)
       VALUES ($2, $1, $3, $4, $5, $6)`,
      [q.ctx.subAccountId, lineId, id, line.priceItemId, line.quantity, position]
    );

    /* The movement, now rather than later. The line is the key, so a retried
       request puts the goods on once. */
    const wrote = await recordMovement(q, {
      priceItemId: line.priceItemId,
      qtyChange: line.quantity,
      reason: "received",
      receivedLineId: lineId,
      note: input.reference?.trim() ? `Delivery ${input.reference.trim()}` : null,
      userId: input.userId,
    });
    if (wrote) moved += 1;
  }

  return { id, moved };
}

/** Deliveries, newest first, with what was on each. */
export async function listReceived(q: TenantQuery, limit = 25): Promise<GoodsReceived[]> {
  const slips = await q.rows<{
    id: string;
    supplier_id: string;
    supplier_name: string;
    reference: string | null;
    received_on: string;
    note: string | null;
    received_by_name: string | null;
    created_at: string;
  }>(
    `SELECT g.id, g.supplier_id, s.name AS supplier_name, g.reference,
            g.received_on::text AS received_on, g.note,
            u.name AS received_by_name, g.created_at
       FROM goods_received g
       JOIN suppliers s ON s.id = g.supplier_id AND s.sub_account_id = g.sub_account_id
       LEFT JOIN users u ON u.id = g.received_by_user_id
      WHERE g.sub_account_id = $1
      ORDER BY g.received_on DESC, g.created_at DESC
      LIMIT $2`,
    [q.ctx.subAccountId, limit]
  );
  if (slips.length === 0) return [];

  const lines = await q.rows<{
    id: string;
    goods_received_id: string;
    price_item_id: string;
    item_name: string;
    unit: string;
    quantity: string;
  }>(
    `SELECT l.id, l.goods_received_id, l.price_item_id,
            p.name AS item_name, p.unit, l.quantity::text
       FROM goods_received_lines l
       JOIN price_items p ON p.id = l.price_item_id AND p.sub_account_id = l.sub_account_id
      WHERE l.sub_account_id = $1 AND l.goods_received_id = ANY($2::text[])
      ORDER BY l.position ASC`,
    [q.ctx.subAccountId, slips.map((s) => s.id)]
  );

  const bySlip = new Map<string, ReceivedLine[]>();
  for (const l of lines) {
    const list = bySlip.get(l.goods_received_id) ?? [];
    list.push({
      id: l.id,
      priceItemId: l.price_item_id,
      itemName: l.item_name,
      unit: l.unit,
      quantity: Number(l.quantity),
    });
    bySlip.set(l.goods_received_id, list);
  }

  return slips.map((s) => ({
    id: s.id,
    supplierId: s.supplier_id,
    supplierName: s.supplier_name,
    reference: s.reference,
    receivedOn: s.received_on,
    note: s.note,
    receivedByName: s.received_by_name,
    createdAt: s.created_at,
    lines: bySlip.get(s.id) ?? [],
  }));
}
