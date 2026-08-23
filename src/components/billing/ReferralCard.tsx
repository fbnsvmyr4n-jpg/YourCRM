"use client";

import { useActionState, useState } from "react";
import { Check, Copy, Gift } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { applyReferralCreditAction, type FormState } from "@/app/(app)/settings/actions";

/**
 * The referral programme, where somebody can actually find it.
 *
 * Credit rather than a discount: the customer gets the same value, and the
 * price of the product never moves — so MRR keeps saying what YourCRM costs.
 *
 * The cap is stated up front rather than discovered at the till. "Covers up to
 * half of any invoice" set out here is a limit somebody plans around; the same
 * limit met as a refusal after they have earned the credit reads as a catch.
 */
export function ReferralCard({
  code,
  balanceCents,
  earnedCents,
  referred,
  applicableCents,
  canManage,
  configured,
}: {
  code: string | null;
  balanceCents: number;
  earnedCents: number;
  referred: number;
  applicableCents: number;
  canManage: boolean;
  configured: boolean;
}) {
  const [state, apply, busy] = useActionState<FormState, FormData>(
    applyReferralCreditAction,
    undefined
  );
  const [copied, setCopied] = useState(false);

  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <Card>
      <CardHeader title="Refer an agency" icon={<Gift className="h-[18px] w-[18px] text-accent" />} />

      <p className="mb-4 text-xs text-muted">
        Send another agency your link and earn 20% of everything they pay, as
        credit against your own bill. Credit covers up to half of any invoice.
      </p>

      {code ? (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl px-3.5 py-3"
          style={{ background: "var(--surface-2)" }}
        >
          <code className="truncate font-mono text-sm">yourcrm.com/signup?ref={code}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(`https://yourcrm.com/signup?ref=${code}`);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="btn-soft focus-ring flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-[var(--green)]" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : (
        <p className="mb-4 text-sm text-faint">Your referral link will appear here shortly.</p>
      )}

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Referred", value: String(referred) },
          { label: "Earned", value: money(earnedCents) },
          { label: "Available", value: money(balanceCents) },
        ].map((s) => (
          <div key={s.label} className="rounded-xl px-3 py-2.5" style={{ background: "var(--surface-2)" }}>
            <p className="text-sm font-semibold tabular-nums">{s.value}</p>
            <p className="mt-0.5 text-xs text-faint">{s.label}</p>
          </div>
        ))}
      </div>

      <Banner state={state} />

      {canManage && balanceCents > 0 && (
        <form action={apply} className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-faint">
            {applicableCents > 0
              ? `${money(applicableCents)} can go against your next invoice.`
              : "Credit applies once you have a subscription to put it against."}
          </p>
          <button
            type="submit"
            disabled={busy || applicableCents <= 0 || !configured}
            className="btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60"
          >
            {busy ? "Applying…" : "Apply credit"}
          </button>
        </form>
      )}

      {!configured && balanceCents > 0 && (
        /* Said rather than hidden. Credit that has been earned and cannot be
           spent is worth explaining, not quietly disabling. */
        <p className="mt-3 text-xs" style={{ color: "var(--amber)" }}>
          Billing is not configured on this deployment, so credit cannot be
          applied yet. It is recorded and will still be there.
        </p>
      )}
    </Card>
  );
}
