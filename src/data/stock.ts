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
