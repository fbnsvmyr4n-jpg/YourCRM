"use client";

import { useActionState, useState } from "react";
import { Check, Copy, Wallet } from "lucide-react";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { useFormDisclosure } from "@/lib/form-disclosure";
import { useKeptForm } from "@/lib/use-kept-form";
import type { PaymentConnection } from "@/server/repos/payments";
import type { FormState } from "./actions";
import { connectPaystackAction, disconnectPaystackAction } from "./payment-actions";

/**
 * How clients pay this business's invoices online.
 *
 * The business connects ITS OWN Paystack account, so the money lands with them.
 * Two things to do, in the order they matter: paste the secret key, then paste
 * the webhook address into Paystack — the second is what lets a payment made
 * after the client closes the tab still be recorded.
 */
export function PaymentsCard({
  connection,
  webhookUrl,
  currency,
  currencySupported,
  canManage,
}: {
  connection: PaymentConnection | null;
  webhookUrl: string;
  currency: string;
  currencySupported: boolean;
  canManage: boolean;
}) {
  const connect = useKeptForm<FormState>(connectPaystackAction, undefined);
  const { state: connectState, pending: connecting } = connect;
  const [disconnectState, disconnect, disconnecting] = useActionState<FormState, FormData>(disconnectPaystackAction, undefined);
  const [open, openForm, closeForm] = useFormDisclosure(connectState, (s) => Boolean(s?.ok));
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <Card>
      <CardHeader
        title="Online payments"
        icon={<Wallet className="h-[18px] w-[18px] text-accent" />}
        action={
          connection ? (
            <CardMeta>{connection.mode === "live" ? "Paystack · live" : "Paystack · test mode"}</CardMeta>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-3">
        <Banner state={disconnectState} />
        {!open && <Banner state={connectState} />}

        {!currencySupported && (
          <p className="rounded-xl px-3.5 py-2.5 text-sm" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
            Paystack does not take payments in {currency}. Pay links appear once your workspace currency is ZAR, USD, NGN,
            GHS or KES.
          </p>
        )}

        {connection ? (
          <>
            <p className="text-sm text-muted">
              Sent invoices carry a <strong className="text-[var(--text)]">Pay now</strong> link. Clients pay by card on
              Paystack&apos;s checkout and the money goes to your Paystack account; the invoice is marked paid when
              Paystack confirms it. Key ending <span className="font-mono">…{connection.keyLast4}</span>.
            </p>

            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">
                Webhook URL — paste into Paystack → Settings → API Keys &amp; Webhooks
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-[var(--border)] px-2.5 py-2 text-xs">
                  {webhookUrl}
                </code>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(webhookUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    } catch {
                      /* Clipboard refused: the address is on screen to copy by hand. */
                    }
                  }}
                  className="btn-soft focus-ring flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-faint">
                Without it, a payment is still recorded when the client comes back to the pay page — but not if they
                close the tab first.
              </p>
            </div>

            {canManage && !open && (
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={openForm} className="btn-soft focus-ring rounded-xl px-3.5 py-2 text-xs font-semibold">
                  Replace key
                </button>
                {confirming ? (
                  <form action={disconnect} className="flex items-center gap-2">
                    <span className="text-xs text-muted">Stop taking card payments?</span>
                    <button type="button" onClick={() => setConfirming(false)} className="btn-soft focus-ring rounded-lg px-2.5 py-1.5 text-xs font-medium">
                      Keep
                    </button>
                    <button type="submit" disabled={disconnecting} className="btn-soft focus-ring rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red disabled:opacity-60">
                      Disconnect
                    </button>
                  </form>
                ) : (
                  <button type="button" onClick={() => setConfirming(true)} className="focus-ring rounded-lg px-2 py-1.5 text-xs font-medium text-faint hover:text-[var(--red)]">
                    Disconnect
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-muted">
              Let clients pay invoices by card. Connect your Paystack account and every invoice you send gets a Pay now
              link; payments go straight to you and the invoice marks itself paid.
            </p>
            {canManage ? (
              !open && (
                <button type="button" onClick={openForm} className="btn-accent focus-ring self-start rounded-xl px-4 py-2 text-sm font-semibold">
                  Connect Paystack
                </button>
              )
            ) : (
              <p className="text-xs text-faint">The owner or accounts can connect it.</p>
            )}
          </>
        )}

        {open && canManage && (
          <form {...connect.formProps} className="flex flex-col gap-3 rounded-xl border border-[var(--border)] p-3.5">
            <Banner state={connectState} />
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Paystack secret key</span>
              <input
                name="secretKey"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
                placeholder="sk_live_…"
                className="field-input font-mono"
              />
              <span className="mt-1.5 block text-xs text-faint">
                Paystack → Settings → API Keys &amp; Webhooks. Stored encrypted; only its last four characters are ever
                shown. Use a test key (sk_test_…) to try it first.
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeForm} className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-medium">
                Cancel
              </button>
              <button type="submit" disabled={connecting} className="btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60">
                {connecting ? "Checking with Paystack…" : "Connect"}
              </button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
