"use client";

import { useState } from "react";
import { Banknote } from "lucide-react";
import { useKeptForm } from "@/lib/use-kept-form";
import { useMoney } from "@/components/money/CurrencyProvider";
import { useMaySettle } from "@/components/shell/MaySettle";
import { recordPaymentAction } from "@/app/(app)/projects/actions";
import { PAYMENT_METHODS } from "@/data/payment-methods";
import type { FormState } from "@/app/(app)/projects/actions";

/**
 * Entering money that arrived for an invoice outside the card provider.
 *
 * This is where picking "paid" out of a status menu used to be. The difference
 * is what gets written: a menu recorded a word, this records the amount, the
 * day, how it came and who says so — and the invoice then settles itself from
 * the total received. Which means a client who pays half is finally something
 * the product can say, instead of being rounded to "paid" or to nothing.
 *
 * Shown only to those who may confirm money arrived, and only while there is
 * something left to pay. Offering it on a settled invoice is an invitation to
 * record the same transfer twice.
 */
export function RecordPayment({
  documentId,
  number,
  dueCents,
  receivedCents,
  today,
}: {
  documentId: string;
  number: string;
  /** What the client owes, lines plus VAT. */
  dueCents: number;
  /** What has arrived so far. */
  receivedCents: number;
  /** The business's own today, so the date starts on the right day. */
  today: string;
}) {
  const maySettle = useMaySettle();
  const { format } = useMoney();
  const [open, setOpen] = useState(false);
  const { state, onSubmit, pending } = useKeptForm<FormState>(recordPaymentAction, undefined);

  const outstanding = Math.max(0, dueCents - receivedCents);
  if (!maySettle || outstanding === 0) return null;

  const part = receivedCents > 0;

  return (
    <div className="mt-3">
      {part && (
        <p className="mb-2 text-xs text-muted">
          {format(receivedCents, "cents")} received of {format(dueCents, "cents")} —{" "}
          <span className="font-semibold text-[var(--amber)]">{format(outstanding, "cents")} outstanding</span>.
        </p>
      )}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn-soft focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold"
        >
          <Banknote className="h-3.5 w-3.5" />
          {part ? "Record another payment" : "Record a payment"}
        </button>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-2 rounded-xl p-3" style={{ background: "var(--surface-2)" }}>
          <input type="hidden" name="documentId" value={documentId} />
          <p className="text-xs font-semibold">Money received for {number}</p>

          <div className="grid gap-2 @min-[440px]:grid-cols-3">
            <label className="flex flex-col gap-1 text-[11px] font-medium text-faint">
              Amount
              {/* Defaulted to what is still owed, which is what arrives in the
                  overwhelming majority of cases — and editable, because the
                  whole point of this box is that a short payment can be told
                  the truth about. */}
              <input
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                required
                defaultValue={(outstanding / 100).toFixed(2)}
                className="focus-ring rounded-lg border border-[var(--border)] bg-[var(--panel-solid)] px-2.5 py-1.5 text-sm tabular-nums text-[var(--text)]"
              />
            </label>

            <label className="flex flex-col gap-1 text-[11px] font-medium text-faint">
              Arrived on
              {/* `max` as well as a server check: a date picker makes next year
                  one mis-click away, and a payment dated into the future falls
                  out of every report that covers today. */}
              <input
                name="paidOn"
                type="date"
                required
                defaultValue={today}
                max={today}
                className="focus-ring rounded-lg border border-[var(--border)] bg-[var(--panel-solid)] px-2.5 py-1.5 text-sm text-[var(--text)]"
              />
            </label>

            <label className="flex flex-col gap-1 text-[11px] font-medium text-faint">
              How
              <select
                name="method"
                defaultValue="transfer"
                className="focus-ring rounded-lg border border-[var(--border)] bg-[var(--panel-solid)] px-2.5 py-1.5 text-sm capitalize text-[var(--text)]"
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m} className="capitalize">
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-[11px] font-medium text-faint">
            Reference (optional)
            <input
              name="note"
              maxLength={120}
              placeholder="What the bank statement calls it"
              className="focus-ring rounded-lg border border-[var(--border)] bg-[var(--panel-solid)] px-2.5 py-1.5 text-sm text-[var(--text)]"
            />
          </label>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="focus-ring rounded-lg px-3 py-1.5 text-xs font-medium text-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="btn-accent focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
            >
              {pending ? "Recording…" : "Record it"}
            </button>
          </div>

          {/* Said where the work was done. A result shown at the top of the
              card is a result nobody scrolls back up to read. */}
          {state?.error && <p className="text-xs font-medium text-red">{state.error}</p>}
          {state?.ok && <p className="text-xs font-medium text-[var(--green)]">{state.ok}</p>}
        </form>
      )}
    </div>
  );
}
