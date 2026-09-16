/**
 * Money, in the currency the business actually works in.
 *
 * Every figure in the product used to be printed with a hard-coded "$", in
 * two dozen places, so a crane-hire firm in Cape Town quoting R250,000 saw
 * "$250,000" on its own pipeline — and would have emailed it to a client.
 * The amount was right and the unit was a lie.
 *
 * ── Formatted by hand, on purpose ─────────────────────────────────────────
 *
 * `Intl.NumberFormat` would be shorter, but the same page is rendered twice —
 * once on the server, once in the browser — and the two do not share locale
 * data. "R 1 250,00" on one and "R1,250.00" on the other is a hydration
 * mismatch and a figure that visibly changes as the page loads. One grouping
 * style everywhere (comma thousands, point decimals) is also what people type
 * into this product's own forms.
 *
 * This is the WORKSPACE's money: deals, quotes, invoices, prices, targets.
 * What YourCRM charges a workspace — plans, usage, referral credit — is billed
 * in US dollars and is formatted where that billing lives, not here.
 */

export const CURRENCIES = [
  { code: "ZAR", symbol: "R", name: "South African rand" },
  { code: "USD", symbol: "$", name: "US dollar" },
  { code: "EUR", symbol: "€", name: "Euro" },
  { code: "GBP", symbol: "£", name: "British pound" },
  { code: "AUD", symbol: "A$", name: "Australian dollar" },
  { code: "NZD", symbol: "NZ$", name: "New Zealand dollar" },
  { code: "CAD", symbol: "C$", name: "Canadian dollar" },
  { code: "NAD", symbol: "N$", name: "Namibian dollar" },
  { code: "BWP", symbol: "P", name: "Botswana pula" },
  { code: "KES", symbol: "KSh", name: "Kenyan shilling" },
  { code: "NGN", symbol: "₦", name: "Nigerian naira" },
  { code: "INR", symbol: "₹", name: "Indian rupee" },
  { code: "AED", symbol: "AED ", name: "UAE dirham" },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];

/**
 * What a workspace shows before its owner chooses. US dollars, because that is
 * what every existing workspace has been showing: switching them silently to
 * anything else would change the meaning of figures people already rely on.
 */
export const DEFAULT_CURRENCY: CurrencyCode = "USD";

export function isCurrency(value: unknown): value is CurrencyCode {
  return CURRENCIES.some((c) => c.code === value);
}

export function currencySymbol(code: CurrencyCode): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? "$";
}

/**
 * How much detail a figure needs where it is shown.
 *
 *   whole     R12,500        — totals, cards, pipeline values
 *   exact     R1,250.50      — cents only when there are some (a rate, a line)
 *   cents     R1,250.00      — always two places (documents a client signs)
 *   compact   R4.5K, R1.2M   — tight spaces: chart axes, chips, board columns
 */
export type MoneyStyle = "whole" | "exact" | "cents" | "compact";

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** One decimal, with a trailing ".0" dropped: 4.5, 12, 1.2. */
const oneDecimal = (n: number) => {
  const s = (Math.round(n * 10) / 10).toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};

export function formatMoney(cents: number, currency: CurrencyCode, style: MoneyStyle = "whole"): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  const sign = safe < 0 ? "−" : "";
  const abs = Math.abs(Math.round(safe));
  const symbol = currencySymbol(currency);

  if (style === "compact") {
    const units = abs / 100;
    if (units >= 1_000_000) return `${sign}${symbol}${oneDecimal(units / 1_000_000)}M`;
    if (units >= 1_000) return `${sign}${symbol}${oneDecimal(units / 1_000)}K`;
    return `${sign}${symbol}${Math.round(units)}`;
  }

  if (style === "whole") {
    return `${sign}${symbol}${group(String(Math.round(abs / 100)))}`;
  }

  const whole = group(String(Math.floor(abs / 100)));
  const fraction = String(abs % 100).padStart(2, "0");
  if (style === "exact" && fraction === "00") return `${sign}${symbol}${whole}`;
  return `${sign}${symbol}${whole}.${fraction}`;
}
