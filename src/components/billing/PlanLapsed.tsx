import { LogOut } from "lucide-react";
import { signOutAction } from "@/app/(auth)/actions";
import { Logo, Wordmark } from "@/components/shell/Logo";
import { BillingCard, type BillingView } from "./BillingCard";

/**
 * What a lapsed account sees instead of the product.
 *
 * Rendered by the app layout in place of the page, rather than by a redirect.
 * A layout cannot know which route it is wrapping, so redirecting to Settings
 * would loop the moment Settings itself was the page being wrapped — and it
 * covers every route in the group by construction, with nothing to add to a new
 * page and nothing to forget.
 *
 * Three things this deliberately does NOT do:
 *
 *  - **Hide or delete anything.** The records are untouched and come straight
 *    back on payment. Somebody whose card expired on a Tuesday is a customer
 *    with a problem, not a former customer.
 *  - **Lock them out of paying.** The plan chooser is the page. The billing
 *    actions run with `allowInactive`, precisely so the one thing that fixes
 *    this is the one thing that still works.
 *  - **Blame them.** The trial ending is the normal end of a trial.
 */
export function PlanLapsed({
  billing,
  canManage,
  reason,
}: {
  billing: BillingView;
  canManage: boolean;
  reason: string;
}) {
  return (
    <div className="relative z-[1] flex min-h-screen items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-[720px] animate-fade-up">
        <div className="mb-6 flex items-center gap-2.5">
          <Logo />
          <Wordmark />
        </div>

        <div className="pb-5">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {billing.status === "trialing" ? "Your trial has ended" : "Choose a plan to carry on"}
          </h1>
          <p className="mt-2 max-w-[52ch] text-sm text-muted">
            {reason} Your contacts, deals and calls are all still here and come straight back.
          </p>
        </div>

        {canManage ? (
          <BillingCard billing={billing} canManage />
        ) : (
          /* A member cannot pay, and a page telling them to would send them
             round a loop. Say who can, so they know what to ask for. */
          <p
            className="rounded-xl px-4 py-3 text-sm"
            style={{ background: "var(--amber-soft)", color: "var(--amber)" }}
          >
            Ask the account owner to choose a plan — only they can change the
            subscription.
          </p>
        )}

        <form action={signOutAction} className="mt-6">
          <button
            type="submit"
            className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-red"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
