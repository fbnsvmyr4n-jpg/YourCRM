import { randomBytes } from "node:crypto";
import type { TenantQuery } from "../tenant";
import { STOCK_REASONS, type StockReason } from "@/data/stock";

/**
 * What is on the shelf, and every reason it moved.
 *
 * ── Stock on hand is never stored ─────────────────────────────────────────
 *
 * It is the SUM of `stock_movements`, worked out when asked. The obvious
 * alternative — a number on `price_items` that each sale decrements — is a
 * figure that can disagree with its own history, and once it has drifted there
 * is nothing left to recompute it from. Here the history IS the number.
 *
 * That is a deliberate trade of a little arithmetic for the one property this
 * has to have: a stock figure somebody does not believe is worse than no stock
 * figure, because the first thing anybody asks of one is "why?" and a stored
 * total cannot answer.
 *
 * ── Only items that are goods ─────────────────────────────────────────────
 *
 * `track_stock` is off unless somebody turns it on. A trades business sells
 * labour as well as materials, and "Site labour: 3 in stock" is not a fact
 * about anything.
 */

export type StockMovement = {
  id: string;
  priceItemId: string;
  /** Signed: goods in positive, goods out negative. */
  qtyChange: number;
  reason: StockReason;
  documentId: string | null;
  documentNumber: string | null;
  note: string | null;
  /** NULL means nobody pressed anything — raising an invoice moved it. */
  movedByUserId: string | null;
  movedByName: string | null;
  createdAt: string;
};

/**
 * Record a movement.
 *
 * `documentLineId` is what makes a sale idempotent: the unique index behind it
 * means raising the same invoice twice, or a retried request, moves the goods
 * once. A conflict is not an error — it is the same sale arriving again — so
 * this answers false and the caller carries on.
 */
export async function recordMovement(
  q: TenantQuery,
  input: {
    priceItemId: string;
    qtyChange: number;
    reason: StockReason;
    documentId?: string | null;
    documentLineId?: string | null;
    note?: string | null;
    /** Null for a movement nobody pressed a button for. */
    userId: string | null;
  }
): Promise<boolean> {
  if (!Number.isFinite(input.qtyChange) || input.qtyChange === 0) return false;
  if (!STOCK_REASONS.includes(input.reason)) return false;

  const rows = await q.rows<{ id: string }>(
    `INSERT INTO stock_movements
       (id, sub_account_id, price_item_id, qty_change, reason, document_id, document_line_id, note, moved_by_user_id)
     VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      q.ctx.subAccountId,
      `sm-${randomBytes(9).toString("hex")}`,
      input.priceItemId,
      input.qtyChange,
      input.reason,
      input.documentId ?? null,
      input.documentLineId ?? null,
      input.note?.trim() || null,
      input.userId,
    ]
  );
  return rows.length > 0;
}

/**
 * Stock on hand for every tracked item, keyed by item.
 *
 * One query for the whole price list rather than one per row — the screen draws
 * forty of them, and forty round trips to answer "how many" is how a list stops
 * feeling instant.
 *
 * Items with no movements are absent rather than zero. The caller knows which
 * items it asked about; this knows only what has moved.
 */
export async function stockOnHand(q: TenantQuery): Promise<Record<string, number>> {
  const rows = await q.rows<{ price_item_id: string; on_hand: string }>(
    `SELECT m.price_item_id, SUM(m.qty_change)::text AS on_hand
       FROM stock_movements m
       JOIN price_items p
         ON p.id = m.price_item_id AND p.sub_account_id = m.sub_account_id
      WHERE m.sub_account_id = $1 AND p.deleted_at IS NULL AND p.track_stock
      GROUP BY m.price_item_id`,
    [q.ctx.subAccountId]
  );

  const out: Record<string, number> = {};
  for (const r of rows) out[r.price_item_id] = Number(r.on_hand);
  return out;
}

/**
 * Why one item's figure is what it is, newest first.
 *
 * The question asked the moment a count looks wrong, and the reason the running
 * total was not stored: every row here is a thing that happened, with the
 * document it happened on and the person who did it.
 */
export async function movementsFor(
  q: TenantQuery,
  priceItemId: string,
  limit = 50
): Promise<StockMovement[]> {
  const rows = await q.rows<{
    id: string;
    price_item_id: string;
    qty_change: string;
    reason: string;
    document_id: string | null;
    document_number: string | null;
    note: string | null;
    moved_by_user_id: string | null;
    moved_by_name: string | null;
    created_at: string;
  }>(
    `SELECT m.id, m.price_item_id, m.qty_change::text, m.reason,
            m.document_id, d.number AS document_number,
            m.note, m.moved_by_user_id, u.name AS moved_by_name, m.created_at
       FROM stock_movements m
       LEFT JOIN documents d
         ON d.id = m.document_id AND d.sub_account_id = m.sub_account_id
       LEFT JOIN users u ON u.id = m.moved_by_user_id
      WHERE m.sub_account_id = $1 AND m.price_item_id = $2
      ORDER BY m.created_at DESC
      LIMIT $3`,
    [q.ctx.subAccountId, priceItemId, limit]
  );

  return rows.map((r) => ({
    id: r.id,
    priceItemId: r.price_item_id,
    qtyChange: Number(r.qty_change),
    reason: r.reason as StockReason,
    documentId: r.document_id,
    documentNumber: r.document_number,
    note: r.note,
    movedByUserId: r.moved_by_user_id,
    movedByName: r.moved_by_name,
    createdAt: r.created_at,
  }));
}

/** The tracked items a document's lines point at, with how many each line took. */
export async function soldLinesFor(
  q: TenantQuery,
  documentId: string
): Promise<{ lineId: string; priceItemId: string; quantity: number }[]> {
  const rows = await q.rows<{ id: string; price_item_id: string; quantity: string }>(
    `SELECT l.id, l.price_item_id, l.quantity::text
       FROM document_lines l
       JOIN price_items p
         ON p.id = l.price_item_id AND p.sub_account_id = l.sub_account_id
      WHERE l.sub_account_id = $1
        AND l.document_id = $2
        AND l.price_item_id IS NOT NULL
        AND p.track_stock
        AND p.deleted_at IS NULL`,
    [q.ctx.subAccountId, documentId]
  );
  return rows.map((r) => ({
    lineId: r.id,
    priceItemId: r.price_item_id,
    quantity: Number(r.quantity),
  }));
}
