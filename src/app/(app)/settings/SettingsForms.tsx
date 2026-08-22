"use client";

import { useActionState } from "react";
import { Building2, KeyRound, LogOut, Plus, Target, UserRound } from "lucide-react";
import { signOutAction } from "@/app/(auth)/actions";
import { Card, CardHeader } from "@/components/ui/Card";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Banner } from "@/components/ui/Banner";
import type { Settings } from "@/server/repos/settings";
import type { SafeUser } from "@/server/repos/users";
import type { WorkspaceRow } from "@/server/sub-accounts";
import {
  changePasswordAction,
  createWorkspaceAction,
  switchWorkspaceAction,
  updateProfileAction,
  updateTargetsAction,
  type FormState,
} from "./actions";

export function ProfileForm({ user }: { user: SafeUser }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateProfileAction, undefined);

  return (
    <Card className="card-q">
      <CardHeader title="Profile" icon={<UserRound className="h-[18px] w-[18px] text-accent" />} />
      <form action={action} className="space-y-4">
        <Banner state={state} />
        <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
          <Field label="Full name" name="name" defaultValue={user.name} required />
          <Field label="Email address" name="email" type="email" defaultValue={user.email} required />
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={pending}
            className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Targets that used to be hardcoded constants (`MONTHLY_TARGET`,
 * `WEEKLY_CAPACITY`). The Leads and Meetings pages measure real progress
 * against these, so they belong to the user, not to the source.
 */
/**
 * The zones offered.
 *
 * `Intl.supportedValuesOf` returns several hundred, which is a scroll rather
 * than a choice. This is a short list plus whatever the account is already set
 * to, so an unusual zone set elsewhere is never silently replaced by picking
 * the nearest option in a dropdown.
 */
const COMMON_ZONES = [
  "UTC",
  "Africa/Johannesburg",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Australia/Sydney",
];

export function TargetsForm({ settings }: { settings: Settings }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateTargetsAction, undefined);

  const ZONES = COMMON_ZONES.includes(settings.timeZone)
    ? COMMON_ZONES
    : [settings.timeZone, ...COMMON_ZONES];

  return (
    <Card className="card-q">
      <CardHeader title="Targets & capacity" icon={<Target className="h-[18px] w-[18px] text-accent" />} />
      <form action={action} className="space-y-4">
        <Banner state={state} />
        <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
          <Field
            label="Monthly revenue target ($)"
            name="monthlyTarget"
            type="number"
            // Stored in cents, typed in whole units.
            defaultValue={String(Math.round(settings.monthlyTargetCents / 100))}
            required
          />
          <Field
            label="Weekly meeting capacity"
            name="weeklyCapacity"
            type="number"
            defaultValue={String(settings.weeklyCapacity)}
            required
          />
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-muted">Time zone</span>
          <select
            name="timeZone"
            defaultValue={settings.timeZone}
            className="focus-ring w-full rounded-lg bg-[var(--sunken)] px-3 py-2 text-sm"
          >
            {/* The zone the business works in. Every booking form submits a
                wall-clock time with no zone attached, and this is what turns
                one into a real moment — so the same booking does not land at a
                different time depending on which server handled it. */}
            {ZONES.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-faint">
          Sales Target progress is measured against the revenue target; Workload &amp; Capacity on
          Meetings is measured against the weekly capacity. Meeting times are read and shown in the
          time zone above.
        </p>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={pending}
            className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save targets"}
          </button>
        </div>
      </form>
    </Card>
  );
}

export function PasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(changePasswordAction, undefined);

  return (
    <Card className="card-q">
      <CardHeader title="Password" icon={<KeyRound className="h-[18px] w-[18px] text-accent" />} />
      <form action={action} className="space-y-4">
        <Banner state={state} />
        <Field label="Current password" name="currentPassword" type="password" required />
        <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
          <Field label="New password" name="newPassword" type="password" required />
          <Field label="Confirm new password" name="confirmPassword" type="password" required />
        </div>
        <p className="text-xs text-faint">Must be at least 8 characters.</p>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={pending}
            className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {pending ? "Updating…" : "Change password"}
          </button>
        </div>
      </form>
    </Card>
  );
}

export function AppearanceCard() {
  return (
    <Card>
      <CardHeader title="Appearance" />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Theme</p>
          <p className="mt-0.5 text-xs text-faint">
            Auto follows the time of day — Day, Evening, then Night.
          </p>
        </div>
        <ThemeToggle />
      </div>
    </Card>
  );
}

export function SignOutCard() {
  return (
    <Card>
      <CardHeader title="Session" />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Sign out of YourCRM</p>
          <p className="mt-0.5 text-xs text-faint">You&apos;ll need your password to sign back in.</p>
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-red"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </form>
      </div>
    </Card>
  );
}

/**
 * The client workspaces on this account, and the limit that applies to them.
 *
 * The count against the cap is shown before anyone hits it. A limit a customer
 * only discovers by being refused is a limit that feels like a fault.
 *
 * The switcher is a form rather than a link because switching sets a cookie
 * that changes what every other page reads — that is a write, and it should
 * look like one.
 */
export function WorkspacesCard({
  workspaces,
  current,
  limit,
  planName,
  canManage,
}: {
  workspaces: WorkspaceRow[];
  current: string | null;
  /** `null` means unlimited on this plan. */
  limit: number | null;
  planName: string;
  canManage: boolean;
}) {
  const [createState, create, creating] = useActionState<FormState, FormData>(
    createWorkspaceAction,
    undefined
  );
  const [switchState, doSwitch, switching] = useActionState<FormState, FormData>(
    switchWorkspaceAction,
    undefined
  );
  const atLimit = limit !== null && workspaces.length >= limit;

  return (
    <Card>
      <CardHeader
        title="Client workspaces"
        icon={<Building2 className="h-[18px] w-[18px] text-accent" />}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-faint">
          Each client&apos;s contacts, deals and calls are kept entirely separate.
        </p>
        <span
          className="rounded-full px-3 py-1 text-xs font-semibold"
          style={{
            background: atLimit ? "var(--amber-soft)" : "var(--accent-soft)",
            color: atLimit ? "var(--amber)" : "var(--accent)",
          }}
        >
          {limit === null
            ? `${workspaces.length} · ${planName}`
            : `${workspaces.length} of ${limit} · ${planName}`}
        </span>
      </div>

      <Banner state={switchState} />

      <ul className="flex flex-col gap-2">
        {workspaces.map((w) => {
          const active = w.id === current;
          return (
            <li
              key={w.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl px-3.5 py-3"
              style={{ background: active ? "var(--accent-soft)" : "var(--surface-2)" }}
            >
              <div className="min-w-0 leading-tight">
                <p className="truncate text-sm font-medium">
                  {w.name}
                  {w.isPrimary && (
                    <span className="ml-2 text-xs font-normal text-faint">your own business</span>
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs text-faint">
                  {w.phoneNumber ?? "No number — inbound calls will not route here"}
                </p>
              </div>
              {active ? (
                <span className="text-xs font-semibold text-accent">Current</span>
              ) : (
                <form action={doSwitch}>
                  <input type="hidden" name="subAccountId" value={w.id} />
                  <button
                    type="submit"
                    disabled={switching}
                    className="btn-soft focus-ring rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-60"
                  >
                    Switch
                  </button>
                </form>
              )}
            </li>
          );
        })}
      </ul>

      {canManage && (
        <form action={create} className="mt-4 space-y-4 border-t border-[var(--border)] pt-4">
          <Banner state={createState} />
          <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
            <Field label="Client name" name="name" required />
            <Field label="Phone number (optional)" name="phoneNumber" />
          </div>
          <p className="text-xs text-faint">
            A number routes that client&apos;s inbound calls to their own workspace. It has to be
            unique, because a call can only belong to one of them.
          </p>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={creating}
              className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
            >
              <Plus className="h-4 w-4" />
              {creating ? "Adding…" : "Add workspace"}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

export { BillingCard, type BillingView } from "@/components/billing/BillingCard";

/* ---------------- bits ---------------- */

function Field({
  label,
  name,
  type = "text",
  defaultValue,
  required,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        autoComplete={type === "password" ? "off" : undefined}
        className="field-input"
      />
    </label>
  );
}
