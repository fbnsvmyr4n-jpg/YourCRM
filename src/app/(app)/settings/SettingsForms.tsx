"use client";

import { useActionState } from "react";
import { AlertCircle, Check, KeyRound, LogOut, Target, UserRound } from "lucide-react";
import { signOutAction } from "@/app/(auth)/actions";
import { Card, CardHeader } from "@/components/ui/Card";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import type { Settings } from "@/server/settings-repo";
import type { SafeUser } from "@/server/users-repo";
import {
  changePasswordAction,
  updateProfileAction,
  updateTargetsAction,
  type FormState,
} from "./actions";

export function ProfileForm({ user }: { user: SafeUser }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateProfileAction, undefined);

  return (
    <Card>
      <CardHeader title="Profile" icon={<UserRound className="h-[18px] w-[18px] text-accent" />} />
      <form action={action} className="space-y-4">
        <Banner state={state} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
export function TargetsForm({ settings }: { settings: Settings }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateTargetsAction, undefined);

  return (
    <Card>
      <CardHeader title="Targets & capacity" icon={<Target className="h-[18px] w-[18px] text-accent" />} />
      <form action={action} className="space-y-4">
        <Banner state={state} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Monthly revenue target ($)"
            name="monthlyTarget"
            type="number"
            defaultValue={String(settings.monthlyTarget)}
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
        <p className="text-xs text-faint">
          Sales Target progress on Leads is measured against the revenue target; Workload &amp;
          Capacity on Meetings is measured against the weekly capacity.
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
    <Card>
      <CardHeader title="Password" icon={<KeyRound className="h-[18px] w-[18px] text-accent" />} />
      <form action={action} className="space-y-4">
        <Banner state={state} />
        <Field label="Current password" name="currentPassword" type="password" required />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

/* ---------------- bits ---------------- */

function Banner({ state }: { state: FormState }) {
  if (!state) return null;
  const ok = !!state.ok;
  return (
    <p
      className="flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm"
      style={{
        background: ok ? "var(--green-soft)" : "var(--red-soft)",
        color: ok ? "var(--green)" : "var(--red)",
      }}
    >
      {ok ? <Check className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
      {state.ok ?? state.error}
    </p>
  );
}

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
