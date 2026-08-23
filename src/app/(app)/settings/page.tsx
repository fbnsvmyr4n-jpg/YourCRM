import { redirect } from "next/navigation";
import { Database, HardDrive, ShieldAlert, ShieldCheck } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Card, CardHeader } from "@/components/ui/Card";
import { authSecretConfigured } from "@/server/auth";
import { ReferralCard } from "@/components/billing/ReferralCard";
import { UsageCard } from "@/components/billing/UsageCard";
import { applicableCredit, creditSummary, referralCodeFor } from "@/server/referral-rewards";
import { usageByWorkspace, usageThisMonth } from "@/server/usage";
import { agencyBilling, trialDaysLeft } from "@/server/billing/checkout";
import { PLAN_INFO, PLANS } from "@/server/billing/plans";
import { stripeConfigured } from "@/server/billing/stripe";
import { entitlementsFor, limitOf } from "@/server/entitlements";
import { roleCan } from "@/server/permissions";
import { getSettings } from "@/server/repos/settings";
import { listSubAccounts } from "@/server/sub-accounts";
import { withSystem } from "@/server/tenant";
import { currentUser, requireTenantPage, withTenantPage } from "@/server/tenant-session";
import { storageEngine } from "@/server/store";
import {
  AppearanceCard,
  PasswordForm,
  ProfileForm,
  SignOutCard,
  BillingCard,
  TargetsForm,
  WorkspacesCard,
} from "./SettingsForms";

export const dynamic = "force-dynamic";

/** The names on the pricing page, not the identifiers in the column. */
const PLAN_NAMES: Record<string, string> = {
  starter: "Starter",
  unlimited: "Unlimited",
  saas_pro: "SaaS Pro",
};

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const engine = storageEngine();
  const secretOk = authSecretConfigured();
  // One tenant round trip for both — they render on the same page.
  const { settings, usage } = await withTenantPage(async (q) => ({
    settings: await getSettings(q),
    usage: await usageThisMonth(q),
  }));

  // The workspace list and the plan behind it. Read here rather than in the
  // client component so the cap comes from the database on every render — a
  // limit cached in the bundle is a limit that stays wrong after an upgrade.
  const tenant = await requireTenantPage();

  // Read on every render rather than cached: a cancellation should take effect
  // on the next page load, not whenever somebody signs out.
  const account = await withSystem((q) => agencyBilling(q, user.agencyId));

  // The referral programme: their own code, what it has earned, and how much of
  // it can go against the next bill.
  const referral = await withSystem(async (q) => {
    const code = await referralCodeFor(q, user.agencyId);
    const summary = await creditSummary(q, user.agencyId);
    const counted = await q.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM agencies
       WHERE referred_by_agency_id = $1 AND deleted_at IS NULL`,
      [user.agencyId]
    );
    const price = PLAN_INFO[(account?.plan ?? "starter") as keyof typeof PLAN_INFO]?.priceCents ?? 0;
    return {
      code,
      balanceCents: summary.balanceCents,
      earnedCents: summary.earnedCents,
      referred: Number(counted?.n ?? 0),
      applicableCents: applicableCredit(summary.balanceCents, price),
    };
  });
  const billing = {
    plan: account?.plan ?? "starter",
    planName: PLAN_NAMES[account?.plan ?? "starter"] ?? "Starter",
    status: (account?.plan_status ?? "trialing") as "trialing" | "active" | "past_due" | "canceled",
    trialDaysLeft: trialDaysLeft(account?.trial_ends_at ?? null),
    hasSubscription: Boolean(account?.stripe_customer_id),
    configured: stripeConfigured(),
    plans: PLANS.map((p) => PLAN_INFO[p]),
  };
  const { workspaces, perWorkspace, plan, limit } = await withSystem(async (q) => {
    const rows = await listSubAccounts(q, user.agencyId);
    const perWorkspace = await usageByWorkspace(q, user.agencyId);
    const e = await entitlementsFor(q, user.agencyId);
    const cap = limitOf(e, "sub_accounts");
    return {
      perWorkspace,
      workspaces: rows,
      plan: PLAN_NAMES[e.plan] ?? e.plan,
      // `0` means the plan does not include extra workspaces at all; the one
      // they already have is their own business, so show it as the limit.
      limit: cap === 0 ? rows.length : cap,
    };
  });

  return (
    <div className="mx-auto max-w-[900px] animate-fade-up">
      <div className="pb-5 pt-1">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Settings</h1>
        <p className="mt-1 text-sm text-muted">Manage your account, security, and preferences.</p>
      </div>

      {/* Account summary */}
      <Card className="mb-5">
        <div className="flex items-center gap-4">
          <Avatar
            initials={
              // Derived from the name rather than stored. A second copy of
              // somebody's initials is a second thing to keep in step.
              user.name
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((p) => p[0])
                .join("")
                .toUpperCase() || "?"
            }
            color="blue"
            size="lg"
          />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-lg font-semibold">{user.name}</p>
            <p className="truncate text-sm text-muted">{user.email}</p>
          </div>
          <span
            className="rounded-full px-3 py-1 text-xs font-semibold text-accent"
            style={{ background: "var(--accent-soft)" }}
          >
            {user.role}
          </span>
        </div>
      </Card>

      <div className="flex flex-col gap-5">
        <ProfileForm user={user} />
        <UsageCard usage={usage} byWorkspace={perWorkspace} />
        <ReferralCard
          code={referral.code}
          balanceCents={referral.balanceCents}
          earnedCents={referral.earnedCents}
          referred={referral.referred}
          applicableCents={referral.applicableCents}
          canManage={roleCan(user.role, "manage_billing")}
          configured={stripeConfigured()}
        />
        <BillingCard billing={billing} canManage={roleCan(user.role, "manage_billing")} />
        <WorkspacesCard
          workspaces={workspaces}
          current={tenant.subAccountId}
          limit={limit}
          planName={plan}
          canManage={roleCan(user.role, "manage_workspaces")}
        />
        <TargetsForm settings={settings} />
        <PasswordForm />
        <AppearanceCard />

        {/* Storage engine — makes the deploy blocker visible */}
        <Card>
          <CardHeader title="Data storage" />
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
                style={{
                  background: engine === "postgres" ? "var(--green-soft)" : "var(--amber-soft)",
                  color: engine === "postgres" ? "var(--green)" : "var(--amber)",
                }}
              >
                {engine === "postgres" ? <Database className="h-5 w-5" /> : <HardDrive className="h-5 w-5" />}
              </span>
              <div className="min-w-0 leading-tight">
                <p className="text-sm font-medium">
                  {engine === "postgres" ? "Postgres database" : "Local files"}
                </p>
                <p className="mt-0.5 text-xs text-faint">
                  {engine === "postgres"
                    ? "Your data is stored in Postgres — ready for production."
                    : "Development storage. Set DATABASE_URL before deploying, or data won't persist."}
                </p>
              </div>
            </div>
            <span
              className="rounded-full px-3 py-1 text-xs font-semibold"
              style={{
                background: engine === "postgres" ? "var(--green-soft)" : "var(--amber-soft)",
                color: engine === "postgres" ? "var(--green)" : "var(--amber)",
              }}
            >
              {engine === "postgres" ? "PRODUCTION READY" : "DEV ONLY"}
            </span>
          </div>

          {/* Session signing. Without a real AUTH_SECRET the app falls back to
              a secret that lives in the source, which makes session cookies
              forgeable — so it is called out here rather than left invisible. */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--border)] pt-4">
            <div className="flex items-center gap-3">
              <span
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
                style={{
                  background: secretOk ? "var(--green-soft)" : "var(--red-soft)",
                  color: secretOk ? "var(--green)" : "var(--red)",
                }}
              >
                {secretOk ? <ShieldCheck className="h-5 w-5" /> : <ShieldAlert className="h-5 w-5" />}
              </span>
              <div className="min-w-0 leading-tight">
                <p className="text-sm font-medium">Session signing key</p>
                <p className="mt-0.5 text-xs text-faint">
                  {secretOk
                    ? "AUTH_SECRET is set — session cookies are signed with your own key."
                    : "Using the built-in dev key. Anyone with the source could forge a login. Set AUTH_SECRET before deploying."}
                </p>
              </div>
            </div>
            <span
              className="rounded-full px-3 py-1 text-xs font-semibold"
              style={{
                background: secretOk ? "var(--green-soft)" : "var(--red-soft)",
                color: secretOk ? "var(--green)" : "var(--red)",
              }}
            >
              {secretOk ? "SECURE" : "DEV ONLY"}
            </span>
          </div>
        </Card>

        <SignOutCard />
      </div>
    </div>
  );
}
