/**
 * The vocabulary of a stock movement.
 *
 * Inert on purpose — no database, no server import — so the price list, which
 * is a client component, can read it. A client component that imports from
 * `repos/*` drags `node:crypto` into the browser bundle: it type-checks, it
 * builds, and the page renders blank at run time. That has happened twice in
 * this codebase, which is why shared inert things live here.
 */

/**
 * Why stock moved.
 *
 * Said as a word rather than inferred from the sign of the number, because
 * "somebody wrote four off" and "a stock take found four fewer" are different
 * facts and a negative number cannot tell them apart. The first is a loss
 * somebody is accountable for; the second is the count catching up with the
 * shelf.
 */
export const STOCK_REASONS = ["received", "sold", "returned", "written_off", "counted"] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

export const REASON_LABEL: Record<StockReason, string> = {
  received: "Received",
  sold: "Sold",
  returned: "Returned",
  written_off: "Written off",
  counted: "Stock take",
};

/**
 * The reasons a PERSON may choose when adjusting by hand.
 *
 * `sold` is not among them. Stock leaves on an invoice, with the line that took
 * it recorded against the movement — a hand-entered "sold" would be a number
 * with no document behind it, and the first question anybody asks of a stock
 * figure is which sale moved it. Returns are here because a return genuinely
 * is something a person records.
 */
export const ADJUSTABLE_REASONS: readonly StockReason[] = [
  "received",
  "returned",
  "written_off",
  "counted",
];

/** Which way a reason moves the shelf, for a form that should not ask twice. */
export const REASON_DIRECTION: Record<StockReason, "in" | "out" | "either"> = {
  received: "in",
  returned: "in",
  sold: "out",
  written_off: "out",
  /* A stock take is the one that can go either way: the count is whatever the
     shelf actually holds, and the movement is the difference. */
  counted: "either",
};

/**
 * What happened to the goods on a credit note.
 *
 * Asked, never inferred. The same credit note means "two pallets came back to
 * the yard" and "I knocked R5,000 off and they kept everything" — opposite
 * facts about the shelf, and nothing in the document tells them apart.
 *
 * `none` is first because it is the DEFAULT, and the default is the answer
 * whose mistake is survivable: stock put back that never arrived is a shelf
 * claiming materials nobody can find, which gets quoted against and fails a
 * job. Stock not put back that did arrive is one unnecessary purchase order,
 * which a stock take corrects. Reasoning in full in `server/stock-credit.ts`.
 */
export const DISPOSITIONS = ["none", "resellable", "damaged"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * How each answer reads where somebody chooses it.
 *
 * Written as what the press DOES rather than as a category, because the control
 * carrying these is the one that issues the credit note — so each says both
 * halves of what is about to happen.
 */
export const DISPOSITION_LABEL: Record<Disposition, string> = {
  none: "Issue — nothing comes back",
  resellable: "Issue — goods back on the shelf",
  damaged: "Issue — goods back, damaged",
};

/**
 * How a quantity reads on screen.
 *
 * Quantities are NUMERIC(14,3) because half a cubic metre of sand is a real
 * amount — but "12.000 in stock" reads like a machine. Trailing zeros go, the
 * meaningful decimals stay.
 */
export function formatQty(qty: number): string {
  if (!Number.isFinite(qty)) return "—";
  return String(Number(qty.toFixed(3)));
}
