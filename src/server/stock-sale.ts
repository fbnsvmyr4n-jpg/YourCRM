import { recordMovement, soldLinesFor } from "./repos/stock";
import type { TenantQuery } from "./tenant";

/**
 * Goods leaving the shelf because an invoice was raised.
 *
 * ── Why raising, and not sending or payment ───────────────────────────────
 *
 * Bradley's call, and the right one for a trades business: the materials go out
 * with the crew. By the time you are billing for them they are on the client's
 * site, whatever the invoice's status says and whoever has paid. Waiting for
 * payment would leave stone that is already laid showing as available, which is
 * the version of this figure that gets somebody to quote work they cannot do.
 *
 * It is a decision with a cost, and the cost is worth naming: an invoice raised
 * and then cancelled has taken stock that never left. That is what
 * `returnStockForInvoice` is for, and cancelling is a deliberate act with a
 * person behind it — unlike the alternative, where the figure is quietly wrong
 * all the time.
 *
 * ── Only lines that know what they are ────────────────────────────────────
 *
 * A movement needs a price item, which a line only has if it was PICKED from
 * the list. A hand-typed line moves nothing, deliberately: the alternative is
 * matching its description back to a price item by name, and two suppliers can
 * both sell "Paving stone" at different rates. Guessing which shelf to empty is
 * worse than not emptying one.
 *
 * Nothing here throws. An invoice is the thing the person asked for; stock is a
 * consequence of it, and a stock row that could not be written must not lose
 * them the invoice. It fails quietly and the count is corrected by a stock
 * take, which is a thing this product has.
 */
export async function takeStockForInvoice(q: TenantQuery, invoiceId: string): Promise<number> {
  let moved = 0;
  try {
    for (const line of await soldLinesFor(q, invoiceId)) {
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) continue;
      const wrote = await recordMovement(q, {
        priceItemId: line.priceItemId,
        /* Out, so negative. The sign is what makes the sum work; the reason is
           what makes it explicable. */
        qtyChange: -line.quantity,
        reason: "sold",
        documentId: invoiceId,
        /* The line is the natural key, and the unique index behind it is what
           makes raising the same invoice twice take the goods once. */
        documentLineId: line.lineId,
        userId: null,
      });
      if (wrote) moved += 1;
    }
  } catch {
    /* Deliberately silent — see above. */
  }
  return moved;
}

/**
 * Goods coming back because an invoice was cancelled.
 *
 * The other half of raising being the moment. A cancelled invoice is work that
 * is not happening, so the materials are still ours — and leaving the shelf
 * short would be a figure nobody could explain, which is the one thing a stock
 * count must never be.
 *
 * Recorded as a RETURN rather than by deleting the sale. The shelf is a history
 * here, not a number: "sold 40, returned 40" is what happened, and a count that
 * can be rewritten is a count that can be argued with.
 */
export async function returnStockForInvoice(
  q: TenantQuery,
  invoiceId: string,
  userId: string | null
): Promise<number> {
  let moved = 0;
  try {
    const sold = await q.rows<{ price_item_id: string; qty_change: string; document_line_id: string | null }>(
      `SELECT price_item_id, qty_change::text, document_line_id
         FROM stock_movements
        WHERE sub_account_id = $1 AND document_id = $2 AND reason = 'sold'`,
      [q.ctx.subAccountId, invoiceId]
    );

    for (const row of sold) {
      /* Only what has not already come back. Cancelling twice must not put the
         goods on the shelf twice, and the sale's own line is how the pair is
         matched. */
      const already = await q.one<{ n: string }>(
        `SELECT count(*)::text AS n FROM stock_movements
          WHERE sub_account_id = $1 AND document_id = $2 AND reason = 'returned'
            AND price_item_id = $3`,
        [q.ctx.subAccountId, invoiceId, row.price_item_id]
      );
      if (Number(already?.n ?? 0) > 0) continue;

      const wrote = await recordMovement(q, {
        priceItemId: row.price_item_id,
        /* Back in: the sale was negative, so this is its opposite. */
        qtyChange: -Number(row.qty_change),
        reason: "returned",
        documentId: invoiceId,
        note: "Invoice cancelled",
        userId,
      });
      if (wrote) moved += 1;
    }
  } catch {
    /* Same reasoning as above: the cancellation is what was asked for. */
  }
  return moved;
}
