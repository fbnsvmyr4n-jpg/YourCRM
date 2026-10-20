import { recordMovement } from "./repos/stock";
import type { TenantQuery } from "./tenant";

/**
 * Goods coming back because a credit note was issued — or not coming back.
 *
 * ── WHY THIS IS ASKED AND NEVER INFERRED ──────────────────────────────────
 *
 * A credit note cannot tell you what happened to the goods. The same document
 * means "two pallets came back to the yard" and "I knocked R5,000 off as
 * goodwill and they kept everything", and those are opposite facts about the
 * shelf. Any rule that decided this automatically would be guessing, and a
 * guess about stock is one nobody ever sees is wrong.
 *
 * ── WHY THE DEFAULT IS THAT NOTHING CAME BACK ─────────────────────────────
 *
 * The two mistakes do not cost the same. Stock put back that never arrived is
 * a shelf claiming materials nobody can put their hands on: it gets quoted
 * against, a crew is sent, and the job fails. Stock NOT put back that did
 * arrive is a shelf that understates, and the cost is one unnecessary purchase
 * order, corrected by the stock take this product already has.
 *
 * One of those errors is recoverable and the other is not, so the default is
 * the recoverable one. It is also the common case: most credit notes correct a
 * charge rather than a delivery.
 *
 * ── WHY DAMAGED IS ITS OWN ANSWER ─────────────────────────────────────────
 *
 * Damaged goods must not simply go back on the shelf, or they get quoted to
 * the next client. But they must not vanish either, or the business cannot see
 * what damage is costing it. So they are recorded as BOTH — returned, then
 * written off. On hand is unchanged, which is the truth, and the history says
 * why, which is the point of keeping a history rather than a number.
 */

/* The three answers live in `src/data/stock.ts`, not here. The ledger is a
   client component and has to draw them; importing them from this module would
   drag `repos/stock` — and `node:crypto` with it — into the browser bundle,
   which type-checks, builds, and renders the page blank. Twice now. */
import type { Disposition } from "@/data/stock";

export type CreditLine = { lineId: string; priceItemId: string; quantity: number };

/**
 * The lines of a credit note that are tracked goods.
 *
 * Only lines PICKED from the price list, for the same reason the sale side
 * only moves those: a hand-typed line has no price item, and matching its
 * description back by name would pick between two suppliers selling "Paving
 * stone" at different rates. Guessing which shelf to fill is worse than not
 * filling one.
 *
 * `track_stock` is asked as well, because a trades business sells labour, and
 * "Site labour: 3 back on the shelf" is not a fact about anything.
 */
export async function creditedStockLines(
  q: TenantQuery,
  creditNoteId: string
): Promise<CreditLine[]> {
  const rows = await q.rows<{ id: string; price_item_id: string; quantity: string }>(
    `SELECT l.id, l.price_item_id, l.quantity::text AS quantity
       FROM document_lines l
       JOIN price_items p
         ON p.id = l.price_item_id AND p.sub_account_id = l.sub_account_id
      WHERE l.sub_account_id = $1
        AND l.document_id = $2
        AND l.price_item_id IS NOT NULL
        AND p.track_stock = TRUE
        AND p.deleted_at IS NULL`,
    [q.ctx.subAccountId, creditNoteId]
  );
  return rows.map((r) => ({
    lineId: r.id,
    priceItemId: r.price_item_id,
    quantity: Number(r.quantity),
  }));
}

/**
 * Put the goods on a credit note back, if they came back.
 *
 * Nothing here throws. The credit note is what the person asked for; stock is a
 * consequence of it, and a movement that could not be written must not lose
 * them the credit — the same rule `takeStockForInvoice` follows, and the count
 * is corrected by a stock take either way.
 *
 * Returns the ITEMS whose shelf actually changed, so the screen can say what it
 * did rather than claim something it did not check.
 *
 * Items and not movement rows, and the difference is not pedantry: 20 paving
 * stones coming back is ONE line and one movement, and a screen reporting the
 * row count said "1 back on the shelf" — read by anybody as one stone. Damaged
 * goods made it worse, writing two rows for one event. A count of lines cannot
 * be mistaken for a quantity, and quantities cannot be summed across items
 * anyway: 20 m² plus 3 days is not 23 of anything.
 */
export async function restockForCreditNote(
  q: TenantQuery,
  creditNoteId: string,
  disposition: Disposition,
  userId: string | null
): Promise<{ items: number }> {
  if (disposition === "none") return { items: 0 };

  let moved = 0;
  try {
    for (const line of await creditedStockLines(q, creditNoteId)) {
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) continue;

      /* In: a credit note's quantities are positive, and these goods are
         arriving. The sign is what makes the sum work; the reason is what
         makes it explicable. */
      const back = await recordMovement(q, {
        priceItemId: line.priceItemId,
        qtyChange: line.quantity,
        reason: "returned",
        documentId: creditNoteId,
        /* The line is the natural key, and the unique index behind it is what
           makes issuing the same credit note twice put the goods back once. */
        documentLineId: line.lineId,
        userId,
      });

      if (disposition === "damaged") {
        /* Straight back off again, as a loss rather than a sale. Two movements
           for one event on purpose: "came back, and was scrapped" is what
           happened, and a single net-zero row would record neither. */
        await recordMovement(q, {
          priceItemId: line.priceItemId,
          qtyChange: -line.quantity,
          reason: "written_off",
          documentId: creditNoteId,
          documentLineId: line.lineId,
          note: "Returned damaged",
          userId,
        });
      }

      /* Counted off the RETURN, which is the movement that says the goods came
         back. The write-off that may follow is what happened to them next, not
         a second item. */
      if (back) moved += 1;
    }
  } catch {
    /* Deliberately silent — see above. */
  }
  return { items: moved };
}
