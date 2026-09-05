import { redirect } from "next/navigation";
import { agencyBilling, trialDaysLeft } from "@/server/billing/checkout";
import { PLAN_INFO, PLANS } from "@/server/billing/plans";
import { stripeConfigured } from "@/server/billing/stripe";
import { PlanLapsed } from "@/components/billing/PlanLapsed";
import { AppShell } from "@/components/shell/AppShell";
import { planState } from "@/server/plan-gate";
import { canAccessCrm, roleCan } from "@/server/permissions";
import { withSystem } from "@/server/tenant";
import { navCounts } from "@/server/nav-counts";
import { listNotifications } from "@/server/notifications";
import { currentUser, withTenantPage } from "@/server/tenant-session";

export const dynamic = "force-dynamic";

type BillingStatus = "trialing" | "active" | "past_due" | "canceled";

export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  // Route guard: every screen inside (app) requires a valid session.
  const user = await currentUser();
  if (!user) redirect("/login");

  /**
   * The plan gate for every page in the group.
   *
   * The layout wraps all of them, so a new page is covered by existing rather
   * than by somebody remembering to add a check — the same reasoning that put
   * the authorisation guard at a shared entry point.
   *
   * It renders the billing screen INSTEAD of the page rather than redirecting:
   * a layout cannot know which route it is wrapping, so a redirect to Settings
   * would loop once Settings was the page being wrapped.
   */
  const plan = await planState(user.agencyId);
  if (!plan.active) {
    const account = await withSystem((q) => agencyBilling(q, user.agencyId));
    return (
      <PlanLapsed
        reason={plan.reason}
        canManage={roleCan(user.role, "manage_billing")}
        billing={{
          plan: account?.plan ?? "starter",
          planName: PLAN_INFO[account?.plan ?? "starter"]?.name ?? "Starter",
          status: (account?.plan_status ?? "canceled") as BillingStatus,
          trialDaysLeft: trialDaysLeft(account?.trial_ends_at ?? null),
          hasSubscription: Boolean(account?.stripe_customer_id),
          configured: stripeConfigured(),
          plans: PLANS.map((p) => PLAN_INFO[p]),
        }}
      />
    );
  }

  // Derived on the server from live records, so the bell is accurate the
  // moment any page renders rather than depending on a client fetch. Read
  // inside the tenant, so it can only ever count this customer's work.
  // One round trip for both: the bell and the sidebar counts are the same
  // question — what is waiting in this workspace — and the layout renders on
  // every navigation.
  /*
     Both of these ARE customer data — what is waiting in the inbox, whose
     meeting is today. A role that cannot open those pages has nothing to be
     notified about, so the queries are skipped rather than run and discarded:
     the cheapest query is the one not sent, and running it would mean this
     layout reading records the reader may not see.

     `crmData: false` on the call itself because the layout wraps EVERY page in
     the group, Settings included. Left gated it would redirect an IT admin to
     Settings, whose layout would redirect them again — the bounce that makes a
     product look broken rather than restricted.
  */
  const crmAccess = canAccessCrm(user.role);
  const { notifications, counts } = crmAccess
    ? await withTenantPage(
        async (q) => ({
          notifications: await listNotifications(q),
          counts: await navCounts(q),
        }),
        { crmData: false }
      )
    : { notifications: [], counts: { inbox: 0, calendarToday: false } };

  return (
    <AppShell
      user={{
        ...user,
        // Derived from the name rather than stored. A second copy of somebody's
        // initials is a second thing to keep in step with it.
        initials:
          user.name
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((p) => p[0])
            .join("")
            .toUpperCase() || "?",
      }}
      notifications={notifications}
      counts={counts}
      /* Presentation only. The refusal lives in `withTenantPage`, which is what
         actually stops an IT admin opening /contacts by typing the URL. Hiding
         the link keeps the sidebar honest about where they can go. */
      crmAccess={crmAccess}
    >
      {children}
    </AppShell>
  );
}
