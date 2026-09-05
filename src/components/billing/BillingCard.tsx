"use client";

import { useActionState, useEffect } from "react";
import { CreditCard, ExternalLink } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { clsx } from "@/lib/clsx";
import type { PlanInfo } from "@/server/billing/plans";
import {
  billingPortalAction,
  startCheckoutAction,
  type FormState,
} from "@/app/(app)/settings/actions";
import { Banner } from "@/components/ui/Banner";

export type BillingView = {
  plan: string;
  planName: string;
  status: "trialing" | "active" | "past_due" | "canceled";
  trialDaysLeft: number;
  hasSubscription: boolean;
  /** False when this deployment has no Stripe keys — said plainly, not hidden. */
  configured: boolean;
  plans: PlanInfo[];
};

/**
 * The subscription, and what to do about it.
 *
 * Every state here is one somebody is actually in, and each says what happens
 * next rather than only what is true now. "Trial" with no end date told a
 * customer nothing; "6 days left" tells them when to decide.
 */
export function BillingCard({ billing, canManage }: { billing: BillingView; canManage: boolean }) {
  const [checkout, startCheckout, checkingOut] = useActionState<FormState, FormData>(
    startCheckoutAction,
    undefined
  );
  const [portal, openPortal, opening] = useActionState<FormState, FormData>(
    billingPortalAction,
    undefined
  );

  // Stripe hands back a URL rather than redirecting from the action, so that a
  // refusal can be shown beside the form instead of navigating away from it.
  const goTo = checkout?.redirect ?? portal?.redirect;
  useEffect(() => {
    if (goTo) window.location.assign(goTo);
  }, [goTo]);

  const tone: Record<BillingView["status"], { bg: string; fg: string; label: string }> = {
    trialing: { bg: "var(--accent-soft)", fg: "var(--accent)", label: "Trial" },
    active: { bg: "var(--green-soft)", fg: "var(--green)", label: "Active" },
    past_due: { bg: "var(--amber-soft)", fg: "var(--amber)", label: "Payment failed" },
    canceled: { bg: "var(--red-soft)", fg: "var(--red)", label: "Cancelled" },
  };
  const badge = tone[billing.status];

  const line = () => {
    if (billing.status === "trialing") {
      return billing.trialDaysLeft > 0
        ? `${billing.trialDaysLeft} ${billing.trialDaysLeft === 1 ? "day" : "days"} left on your trial. Choose a plan to keep going.`
        : "Your trial has ended. Choose a plan to carry on.";
    }
    if (billing.status === "past_due") {
      // Access continues while Stripe retries, and saying so is the difference
      // between a customer updating a card and a customer assuming it is broken.
      return "We could not take the last payment. Your account still works — update your card to keep it that way.";
    }
    if (billing.status === "canceled") return "This subscription has ended. Choose a plan to reactivate.";
    return `You are on ${billing.planName}.`;
  };

  return (
    <Card>
      <CardHeader
        title="Subscription"
        icon={<CreditCard className="h-[18px] w-[18px] text-accent" />}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 leading-tight">
          <p className="text-sm font-medium">{billing.planName}</p>
          <p className="mt-0.5 text-xs text-faint">{line()}</p>
        </div>
        <span
          className="rounded-full px-3 py-1 text-xs font-semibold"
          style={{ background: badge.bg, color: badge.fg }}
        >
          {badge.label}
        </span>
      </div>

      <Banner state={checkout} />
      <Banner state={portal} />

      {!billing.configured ? (
        /* Said rather than hidden. A disabled button with no explanation reads
           as a broken product; this reads as a deployment that is missing a
           setting, which is what it is. */
        <p className="rounded-xl px-3.5 py-2.5 text-sm" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
          Billing is not configured on this deployment, so plans cannot be changed here.
        </p>
      ) : !canManage ? (
        <p className="text-xs text-faint">Only an owner or the finance team can change the subscription.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {billing.hasSubscription && (
            <form action={openPortal}>
              <button
                type="submit"
                disabled={opening}
                className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium disabled:opacity-60"
              >
                <ExternalLink className="h-4 w-4" />
                {opening ? "Opening…" : "Manage billing, cards and invoices"}
              </button>
            </form>
          )}

          <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-3">
            {billing.plans.map((p) => {
              const current = p.plan === billing.plan && billing.status !== "canceled";
              return (
                <form action={startCheckout} key={p.plan} className="contents">
                  <input type="hidden" name="plan" value={p.plan} />
                  <div
                    className="flex flex-col gap-2 rounded-xl p-4"
                    style={{
                      background: current ? "var(--accent-soft)" : "var(--surface-2)",
                    }}
                  >
                    <p className="text-sm font-semibold">{p.name}</p>
                    <p className="text-lg font-bold tabular-nums">
                      ${(p.priceCents / 100).toFixed(0)}
                      <span className="text-xs font-normal text-faint">/mo</span>
                    </p>
                    <p className="flex-1 text-xs text-faint">{p.blurb}</p>
                    <button
                      type="submit"
                      disabled={checkingOut || (current && billing.status === "active")}
                      className={clsx(
                        "focus-ring rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-60",
                        current && billing.status === "active" ? "btn-soft" : "btn-accent"
                      )}
                    >
                      {current && billing.status === "active"
                        ? "Current plan"
                        : checkingOut
                          ? "Opening…"
                          : "Choose"}
                    </button>
                  </div>
                </form>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
