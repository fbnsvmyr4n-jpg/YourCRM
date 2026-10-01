/**
 * VAT, worked out once.
 *
 * Every document that shows tax — the printed sheet, the emailed copy, the
 * public pay page — asks this module rather than doing the sum itself. Three
 * copies of one piece of arithmetic is three chances for a client's copy and
 * ours to disagree by a cent, and a cent is enough for a bookkeeper to reject
 * an invoice.
 *
 * ── Integers throughout ───────────────────────────────────────────────────
 *
 * The rate arrives in basis points (1500 = 15%) and every figure is in cents,
 * so nothing here ever holds a fraction. `totalCents * 15 / 100` in floating
 * point is famously not what it looks like, and the error does not show up on
 * small numbers — it shows up once, on a big invoice, in front of a customer.
 *
 * ── The three numbers always agree ────────────────────────────────────────
 *
 * net + vat === gross, by construction rather than by hope: one of the three is
 * computed and the third is the difference, never rounded independently. Two
 * separately rounded figures that are each correct can still fail to add up,
 * and a document whose own column does not sum is worse than no document.
 */

export type VatBreakdown = {
  /** Before tax. */
  netCents: number;
  /** The tax itself. */
  vatCents: number;
  /** What the other side actually pays. */
  grossCents: number;
  /** Basis points, for the label: 1500 renders as "15%". */
  rateBp: number;
};

/**
 * "15%", "8.75%", "0%" — no trailing zeros, no locale.
 *
 * Hand-formatted like money, and for the same reason: this string is rendered
 * on the server and again in the browser, and `Intl` need not give the two the
 * same answer.
 */
export function rateLabel(rateBp: number): string {
  const whole = Math.trunc(rateBp / 100);
  const fraction = Math.abs(rateBp % 100);
  if (fraction === 0) return `${whole}%`;
  return `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}%`;
}

/**
 * What to show beneath the lines, or null when there is nothing to show.
 *
 * Null at a zero rate, and that is the whole behaviour for a business that is
 * not VAT-registered: no subtotal, no tax row, no "VAT 0.00" on the page
 * inviting a client to ask why they are being charged nothing.
 *
 * `inclusive` says what the typed prices already mean. It is not a preference
 * about presentation — it changes which of the three numbers is the one the
 * lines add up to, and getting it wrong is a document 15% out.
 */
export function vatBreakdown(
  totalCents: number,
  rateBp: number,
  inclusive: boolean
): VatBreakdown | null {
  const rate = Math.trunc(rateBp);
  if (!Number.isFinite(totalCents) || !Number.isFinite(rate) || rate <= 0) return null;

  const total = Math.round(totalCents);

  if (inclusive) {
    /* The lines already include the tax, so the total IS the gross and the net
       is what it was before tax was added: gross × 10000 / (10000 + rate).
       The VAT is then the difference, so the column adds up exactly. */
    const netCents = roundHalfUp(total * 10000, 10000 + rate);
    return { netCents, vatCents: total - netCents, grossCents: total, rateBp: rate };
  }

  /* The lines are before tax, so the total is the net and the client pays more
     than the figures above the line — which is exactly why the control that
     sets this says so in words. */
  const vatCents = roundHalfUp(total * rate, 10000);
  return { netCents: total, vatCents, grossCents: total + vatCents, rateBp: rate };
}

/**
 * What the other side actually owes.
 *
 * The single number a client pays, an invoice settles against and a card is
 * charged — the gross where there is tax, and the typed total where there is
 * none. It exists as its own function because those three places must agree:
 * an invoice shown at R1,150, charged at R1,000 and then marked unpaid because
 * R1,000 did not cover R1,150 is three different answers to one question.
 *
 * It is NOT the figure the pipeline, the reports or a deal's value count. VAT
 * is money collected on behalf of a revenue service, not revenue, and those
 * figures stay the sum of the lines as typed.
 */
export function payableCents(totalCents: number, rateBp: number, inclusive: boolean): number {
  const breakdown = vatBreakdown(totalCents, rateBp, inclusive);
  return breakdown ? breakdown.grossCents : Math.round(totalCents);
}

/**
 * Integer division, rounded half away from zero.
 *
 * `Math.round` rounds half UP, which sends −0.5 to −0 rather than −1 — so a
 * credit note would round the opposite way from the invoice it reverses, and
 * the pair would not cancel. Rare, and exactly the sort of rare that surfaces
 * as an unexplainable cent in somebody's books.
 */
function roundHalfUp(numerator: number, denominator: number): number {
  const sign = numerator < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(numerator) + denominator / 2) / denominator);
}
