"use client";

import { createContext, useContext, useMemo } from "react";
import {
  currencySymbol,
  DEFAULT_CURRENCY,
  formatMoney,
  type CurrencyCode,
  type MoneyStyle,
} from "@/lib/money";

/**
 * The workspace's currency, for every screen underneath the app shell.
 *
 * Read once, on the server, by the layout that wraps every page, and handed
 * down here — so a component that prints an amount asks `useMoney()` instead
 * of each screen threading a currency prop through three layers, which is how
 * the hard-coded "$" spread to two dozen files in the first place.
 */

const CurrencyContext = createContext<CurrencyCode>(DEFAULT_CURRENCY);

export function CurrencyProvider({ currency, children }: { currency: CurrencyCode; children: React.ReactNode }) {
  return <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>;
}

export function useMoney() {
  const currency = useContext(CurrencyContext);
  return useMemo(
    () => ({
      currency,
      symbol: currencySymbol(currency),
      /** Integer cents in, text out. See `MoneyStyle`. */
      format: (cents: number, style: MoneyStyle = "whole") => formatMoney(cents, currency, style),
    }),
    [currency]
  );
}
