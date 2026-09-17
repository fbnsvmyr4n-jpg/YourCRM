"use client";


import { useKeptForm } from "@/lib/use-kept-form";
import { CheckCircle2, Lock } from "lucide-react";
import { formatMoney } from "@/lib/money";
import type { PayPage } from "@/server/pay/pay";
import { payAction, type PayState } from "./actions";

type Shown = Exclude<PayPage, { state: "not_found" }>;

const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
};

/**
 * The invoice, the amount, one button.
 *
 * Laid out like the document the client was emailed, so it is recognisably the
 * same bill. Card details are never typed here — the button hands over to
 * Paystack's own checkout, which says so.
 */
export function PayView({ token, page, notice }: { token: string; page: Shown; notice: { tone: "good" | "bad"; text: string } | null }) {
  const { state, onSubmit: action, pending } = useKeptForm<PayState>(payAction, undefined);
  const money = (cents: number) => formatMoney(cents, page.currency, "cents");
  const paid = page.state === "paid";

  return (
    <main className="@container relative flex min-h-dvh items-start justify-center px-4 py-10 @min-[640px]:items-center">
      <div className="card flex w-full max-w-lg flex-col gap-6 rounded-2xl p-6">
        <header className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-faint">{page.workspaceName}</p>
          <h1 className="text-2xl font-semibold text-balance">Invoice {page.number}</h1>
          <p className="text-sm text-muted">{page.project}</p>
        </header>

        {page.testMode && (
          <p className="rounded-xl px-3.5 py-2.5 text-xs font-medium" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
            Test mode — no real money will be taken.
          </p>
        )}

        {notice && (
          <p
            role="status"
            className="rounded-xl px-3.5 py-2.5 text-sm"
            style={
              notice.tone === "good"
                ? { background: "var(--green-soft)", color: "var(--green)" }
                : { background: "var(--red-soft)", color: "var(--red)" }
            }
          >
            {notice.text}
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {page.lines.map((l, i) => (
                <tr key={i} className="border-b border-[var(--border)]">
                  <td className="py-2 pr-3">{l.description}</td>
                  <td className="whitespace-nowrap py-2 text-right tabular-nums">{money(l.totalCents)}</td>
                </tr>
              ))}
              <tr>
                <td className="pt-3 font-semibold">Total</td>
                <td className="whitespace-nowrap pt-3 text-right font-semibold tabular-nums">{money(page.totalCents)}</td>
              </tr>
              {!paid && page.outstandingCents !== page.totalCents && (
                <tr>
                  <td className="pt-1 text-muted">Still to pay</td>
                  <td className="whitespace-nowrap pt-1 text-right font-semibold tabular-nums">{money(page.outstandingCents)}</td>
                </tr>
              )}
            </tbody>
          </table>
          {page.dueOn && !paid && <p className="mt-2 text-xs text-muted">Due by {day(page.dueOn)}</p>}
        </div>

        {paid ? (
          <p className="flex items-center gap-2 text-base font-semibold" style={{ color: "var(--green)" }}>
            <CheckCircle2 className="h-5 w-5" /> Paid — nothing more to do.
          </p>
        ) : page.state === "payable" ? (
          <form onSubmit={action} className="flex flex-col gap-2">
            <input type="hidden" name="token" value={token} />
            {state?.error && (
              <p className="rounded-xl px-3.5 py-2.5 text-sm" style={{ background: "var(--red-soft)", color: "var(--red)" }} role="alert">
                {state.error}
              </p>
            )}
            <button type="submit" disabled={pending} className="btn-accent focus-ring rounded-xl px-5 py-3 text-base font-semibold disabled:opacity-60">
              {pending ? "Opening secure checkout…" : `Pay ${money(page.outstandingCents)}`}
            </button>
            <p className="flex items-center justify-center gap-1.5 text-xs text-faint">
              <Lock className="h-3 w-3" /> Card details are entered on Paystack&apos;s secure checkout, not here.
            </p>
          </form>
        ) : (
          <p className="text-sm text-muted">{page.reason}</p>
        )}

        {!paid && page.payTo && (
          <div className="border-t border-[var(--border)] pt-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-faint">Or pay by transfer</p>
            <p className="whitespace-pre-line text-sm text-muted">{page.payTo}</p>
          </div>
        )}
      </div>
    </main>
  );
}
