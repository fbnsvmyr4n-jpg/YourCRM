"use client";

import { createContext, useContext } from "react";

/**
 * May the person looking at this screen confirm that money arrived?
 *
 * Handed down by the app shell exactly like `CanWriteProvider`, and read by the
 * payment box on an invoice. `canSettleInvoice` in permissions.ts is the rule;
 * this is only how a control three levels down gets to ask it.
 *
 * ── Why it defaults to FALSE, where canWrite defaults to true ──────────────
 *
 * `canWrite` fails open because its default serves the public pages — a
 * stranger's booking form has no session, and hiding its only button would
 * break the booking. Nothing public records a payment. The one screen outside
 * the shell that touches money is the client's own pay page, and money arriving
 * there is confirmed by the provider, not by the person reading it.
 *
 * So the safe default here is the opposite one. A payment box drawn for a
 * salesperson by accident is the precise thing the separation exists to stop:
 * whoever chased the sale is not whoever confirms it was paid. Drawing it and
 * having the server refuse would teach them the control is arbitrary. Not
 * drawing it says the work is somebody else's, which is true.
 *
 * It is not security either way — `setDocumentStatusAction` and
 * `recordPaymentAction` both check the role themselves, and that is what
 * actually holds.
 */
const MaySettleContext = createContext<boolean>(false);

export function MaySettleProvider({
  maySettle,
  children,
}: {
  maySettle: boolean;
  children: React.ReactNode;
}) {
  return <MaySettleContext.Provider value={maySettle}>{children}</MaySettleContext.Provider>;
}

/** True for an owner or a finance user. */
export function useMaySettle(): boolean {
  return useContext(MaySettleContext);
}
