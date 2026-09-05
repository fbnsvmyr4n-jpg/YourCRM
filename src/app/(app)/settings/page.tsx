import { redirect } from "next/navigation";
import { Database, Download, HardDrive, ShieldAlert, ShieldCheck } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { authSecretConfigured } from "@/server/auth";
import { ReferralCard } from "@/components/billing/ReferralCard";
import { UsageCard } from "@/components/billing/UsageCard";
import { TrashCard } from "@/components/ui/TrashCard";
import { applicableCredit, creditSummary, referralCodeFor } from "@/server/referral-rewards";
import { usageByWorkspace, usageThisMonth } from "@/server/usage";
import { agencyBilling, trialDaysLeft } from "@/server/billing/checkout";
import { PLAN_INFO, PLANS } from "@/server/billing/plans";
import { stripeConfigured } from "@/server/billing/stripe";
import { entitlementsFor, limitOf } from "@/server/entitlements";
import { canAccessCrm, outranks, roleCan } from "@/server/permissions";
import { getSettings } from "@/server/repos/settings";
import { listUsers } from "@/server/repos/users";
import { clientBook, groupByOwner } from "@/server/clients-view";
import { groupByDepartment } from "@/server/directory";
import { listSubAccounts } from "@/server/sub-accounts";
import { listTrash } from "@/server/trash";
import { ROLES, withSystem } from "@/server/tenant";
import { currentUser, requireTenantPage, withTenantPage } from "@/server/tenant-session";
import { storageEngine } from "@/server/store";
import { ClientsCard } from "./ClientsCard";
import { SettingsNav } from "./SettingsNav";
import { sectionFromParam, type SettingsSectionId } from "./sections";
import { TeamCard } from "./TeamCard";
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

/**
 * Initials from a name rather than a stored field. A second copy of somebody's
 * initials is a second thing to keep in step with the name.
 */
function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?"
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ s?: string }>;
}) {
  /* Which area to open, from the URL. Validated here rather than trusted: an
     unrecognised value opens Account instead of rendering nothing. */
  const initial = sectionFromParam((await searchParams).s);

  const user = await currentUser();
  if (!user) redirect("/login");
  const engine = storageEngine();
  const secretOk = authSecretConfigured();
  // One tenant round trip for all three — they render on the same page.
  /*
     Settings is the one screen IT and accounts can open, so it opts out of the
     customer-data gate — and then earns that by not fetching customer data for
     a reader who may not see it. The bin holds deleted contacts and deals; the
     book of business is every contact in the workspace. Both are skipped rather
     than fetched and hidden, because a query that runs and is thrown away has
     still read the records.
  */
  const crmAccess = canAccessCrm(user.role);
  const { settings, usage, trash, book } = await withTenantPage(
    async (q) => ({
      settings: await getSettings(q),
      usage: await usageThisMonth(q),
      // Recovery lives here because this is where somebody looks after deleting
      // the wrong thing, and it costs one more query on a page already open.
      trash: crmAccess ? await listTrash(q) : [],
      // Every contact with their owner and their money, in one statement. Read
      // per person it would re-read the deals table once for every member of
      // the team, and the Clients area shows all of them at once.
      book: crmAccess ? await clientBook(q) : [],
    }),
    { crmData: false }
  );

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
  const { workspaces, perWorkspace, plan, limit, team } = await withSystem(async (q) => {
    const rows = await listSubAccounts(q, user.agencyId);
    const perWorkspace = await usageByWorkspace(q, user.agencyId);
    const e = await entitlementsFor(q, user.agencyId);
    const cap = limitOf(e, "sub_accounts");
    return {
      perWorkspace,
      workspaces: rows,
      team: await listUsers(q, user.agencyId),
      plan: PLAN_NAMES[e.plan] ?? e.plan,
      // `0` means the plan does not include extra workspaces at all; the one
      // they already have is their own business, so show it as the limit.
      limit: cap === 0 ? rows.length : cap,
    };
  });

  const canManageUsers = roleCan(user.role, "manage_users");

  /* Both screens are derived here, on the server, from the same one read of
     `users`. The rank rule in particular: the reader manages people at all,
     this is not the reader themselves, and the reader outranks them. Every
     action re-checks it — this only decides whether the control is drawn. */
  const directory = groupByDepartment(
    team.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      initials: initialsOf(m.name),
      department: m.department,
      jobTitle: m.jobTitle,
      phone: m.phone,
      scope: m.scope,
      isYou: m.id === user.id,
      canManage: canManageUsers && m.id !== user.id && outranks(user.role, m.role),
    }))
  );

  const books = groupByOwner(
    book,
    team.map((m) => ({
      id: m.id,
      name: m.name,
      jobTitle: m.jobTitle,
      department: m.department,
    })),
    user.id
  );

  /**
   * The six areas, in the order they are offered.
   *
   * Each is server-rendered here with its data already in it, and the nav shows
   * one at a time. That keeps the whole screen one round trip — the alternative,
   * a route per area, would be six.
   */
  const allSections: {
    id: SettingsSectionId;
    content: React.ReactNode;
    needsCrm?: boolean;
  }[] = [
    {
      id: "account",
      content: (
        <>
          <ProfileForm user={user} />
          <PasswordForm />
          <SignOutCard />
        </>
      ),
    },
    {
      id: "team",
      content: (
        <TeamCard
          groups={directory}
          headcount={team.length}
          canManage={canManageUsers}
          assignable={ROLES.filter((r) => outranks(user.role, r))}
        />
      ),
    },
    {
      /*
         Who is looking after whom.

         Not the same thing as a workspace, which is why this is a new area
         rather than a rename. A workspace is an isolated tenant with its own
         phone number and its own plan cap — an agency feature, now filed with
         the subscription under Billing where its count and its limit already
         live. This is the sales question: which of OUR people is carrying which
         of OUR contacts.
      */
      id: "clients",
      content: <ClientsCard books={books} readerId={user.id} />,
      /* Every contact in the workspace, by name. This area IS customer data,
         so it is not offered at all to IT or accounts — the tab disappears
         rather than opening onto an empty card, which would only invite the
         question of what is being hidden. */
      needsCrm: true,
    },
    {
      id: "preferences",
      content: (
        <>
          <TargetsForm settings={settings} />
          <AppearanceCard />
        </>
      ),
    },
    {
      id: "billing",
      content: (
        <>
          <BillingCard billing={billing} canManage={roleCan(user.role, "manage_billing")} />
          {/* Workspaces sit with the subscription because that is what they
              are: a plan-limited, agency-level thing whose count and cap are
              already shown beside the price. They are not the same concept as
              the Clients area, and putting them there would have been two
              meanings of the word on one screen. */}
          <WorkspacesCard
            workspaces={workspaces}
            current={tenant.subAccountId}
            limit={limit}
            planName={plan}
            canManage={roleCan(user.role, "manage_workspaces")}
          />
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
        </>
      ),
    },
    {
      id: "data",
      content: (
        <>
          {/* Both of these are the customer records themselves — a CSV of every
              contact, and a bin holding the deleted ones. The platform card
              below stays, because whether this deployment has a real database
              is not a fact about anybody's customers. */}
          {crmAccess && <ExportCard />}
          {crmAccess && <TrashCard items={trash} />}
          {/* Platform status is the account holder's business, not every
              employee's — a member seeing "Set DATABASE_URL before deploying"
              is being told about somebody else's deployment.

              Gated on `manage_billing` rather than on the word "owner": the
              question is who answers for this deployment, and that is the same
              person who answers for the bill. Asked through the matrix so it
              cannot drift from the rest of the screen. */}
          {roleCan(user.role, "manage_billing") && (
            <PlatformCard engine={engine} secretOk={secretOk} />
          )}
        </>
      ),
    },
  ];

  /* An area that needs customer records is not offered to a reader who has
     none. `initial` is re-checked against what survives, so `?s=clients` typed
     by hand opens Account rather than a tab that is not there. */
  const sections = allSections.filter((section) => !section.needsCrm || crmAccess);

  return (
    <div className="mx-auto max-w-[1080px] animate-fade-up">
      <div className="pb-4 pt-1">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Settings</h1>
        <p className="mt-1 text-sm text-muted">Manage your account, your team and how this workspace works.</p>
      </div>

      <SettingsNav
        user={{
          name: user.name,
          email: user.email,
          initials: initialsOf(user.name),
          role: user.role,
          planName: billing.planName,
        }}
        initial={sections.some((s) => s.id === initial) ? initial : "account"}
        sections={sections}
      />
    </div>
  );
}

/**
 * Take your data out.
 *
 * Plain links, not buttons behind script: the browser is already very good at
 * saving a file it was sent, and a download built in the client would mean the
 * same rows crossing the wire twice.
 */
function ExportCard() {
  const entities = [
    { id: "contacts", label: "Contacts", detail: "Names, email, phone, company" },
    { id: "deals", label: "Deals", detail: "Value, stage, source and outcome" },
    { id: "meetings", label: "Meetings", detail: "When, with whom, and how it went" },
    { id: "companies", label: "Companies", detail: "Names, domains and notes" },
  ];

  return (
    <Card>
      <CardHeader title="Export" icon={<Download className="h-[18px] w-[18px] text-accent" />} />
      <p className="mb-3 text-xs text-faint">
        A spreadsheet of this workspace, as it stands right now. Yours to keep.
      </p>
      <div className="grid grid-cols-1 gap-2 @min-[440px]:grid-cols-2">
        {entities.map((e) => (
          <a
            key={e.id}
            href={`/api/export/${e.id}`}
            className="btn-soft focus-ring flex items-center gap-3 rounded-xl px-3.5 py-3"
          >
            <Download className="h-4 w-4 shrink-0 text-accent" />
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-medium">{e.label}</span>
              <span className="mt-0.5 block truncate text-xs text-faint">{e.detail}</span>
            </span>
          </a>
        ))}
      </div>
    </Card>
  );
}

/**
 * Whether this deployment is actually ready to hold customer data.
 *
 * Two conditions that are invisible until the day they matter: data written to
 * files instead of a database, and session cookies signed with a key that lives
 * in the source, which makes a login forgeable by anyone who can read the repo.
 *
 * Compacted from two blocks to two lines, and shown to the owner only. It used
 * to be two thirds of a card on everyone's Settings page, permanently green,
 * explaining an environment variable to people who do not deploy anything.
 */
function PlatformCard({ engine, secretOk }: { engine: string; secretOk: boolean }) {
  const rows = [
    {
      ok: engine === "postgres",
      icon: engine === "postgres" ? Database : HardDrive,
      label: "Data storage",
      good: "Postgres — your records are on a real database.",
      bad: "Local files. Set DATABASE_URL before deploying, or data will not persist.",
    },
    {
      ok: secretOk,
      icon: secretOk ? ShieldCheck : ShieldAlert,
      label: "Session signing key",
      good: "AUTH_SECRET is set — sign-in cookies are signed with your own key.",
      bad: "Using the built-in development key. Anyone with the source could forge a login.",
    },
  ];

  return (
    <Card>
      <CardHeader title="Platform" />
      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const Icon = r.icon;
          const color = r.ok ? "var(--green)" : "var(--red)";
          const soft = r.ok ? "var(--green-soft)" : "var(--red-soft)";
          return (
            <li
              key={r.label}
              className="flex items-center gap-3 rounded-xl px-3.5 py-3"
              style={{ background: r.ok ? "var(--surface-2)" : soft }}
            >
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                style={{ background: soft, color }}
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="text-sm font-medium">{r.label}</p>
                <p className="mt-0.5 text-xs text-faint">{r.ok ? r.good : r.bad}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
