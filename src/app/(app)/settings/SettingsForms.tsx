"use client";

import { useActionState } from "react";
import { useFormDisclosure } from "@/lib/form-disclosure";
import {
  Building2,
  CalendarOff,
  Clock,
  KeyRound,
  LogOut,
  Plus,
  Target,
  Trash2,
  UserRound,
} from "lucide-react";
import { signOutAction } from "@/app/(auth)/actions";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { useTheme } from "@/components/theme/ThemeProvider";
import { Banner } from "@/components/ui/Banner";
import type { Settings } from "@/server/repos/settings";
import {
  formatClock,
  hoursFor,
  SUGGESTED_WEEK,
  WEEKDAYS,
  type OpenDay,
} from "@/server/repos/working-hours";
import type { SafeUser } from "@/server/repos/users";
import type { WorkspaceRow } from "@/server/sub-accounts";
import {
  addHolidayAction,
  changePasswordAction,
  createWorkspaceAction,
  importHolidaysAction,
  removeHolidayAction,
  switchWorkspaceAction,
  updateProfileAction,
  updateTargetsAction,
  updateWorkingHoursAction,
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
          {/* Your own entry in the company directory. It lives here rather than
              under Team because Team deliberately refuses to edit `me` — one
              form, one set of validation, no second way in. */}
          <Field label="Department" name="department" defaultValue={user.department ?? ""} />
          <Field label="Position" name="jobTitle" defaultValue={user.jobTitle ?? ""} />
          <Field label="Phone or extension" name="phone" defaultValue={user.phone ?? ""} />
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Scope of work</span>
          <textarea
            name="scope"
            rows={3}
            defaultValue={user.scope ?? ""}
            placeholder="What you are responsible for"
            className="field-input resize-y"
          />
        </label>
        <p className="text-xs text-faint">
          Everything below your name shows on the Team directory. Leave a field empty to clear it.
        </p>
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

/**
 * Changing a password, behind a disclosure.
 *
 * Three empty password fields were on screen on every visit to Settings, for a
 * thing almost nobody came to do — 315px of the page spent standing ready. The
 * form is one tap away and the answer stays visible after it closes, which is
 * the part a fold usually gets wrong.
 */
export function PasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(changePasswordAction, undefined);
  const [open, openForm, closeForm] = useFormDisclosure(state, (s) => Boolean(s?.ok));

  return (
    <Card className="card-q">
      <CardHeader
        title="Password"
        icon={<KeyRound className="h-[18px] w-[18px] text-accent" />}
        action={
          !open && (
            <button
              type="button"
              onClick={openForm}
              className="btn-soft focus-ring rounded-xl px-4 py-2 text-xs font-semibold"
            >
              Change
            </button>
          )
        }
      />

      {!open && !state && (
        <p className="text-xs text-faint">
          You&apos;ll need your current password to set a new one.
        </p>
      )}
      {!open && state && <Banner state={state} />}

      {open && (
        <form action={action} className="space-y-4">
          <Banner state={state} />
          <Field label="Current password" name="currentPassword" type="password" required />
          <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
            <Field label="New password" name="newPassword" type="password" required />
            <Field label="Confirm new password" name="confirmPassword" type="password" required />
          </div>
          <p className="text-xs text-faint">Must be at least 8 characters.</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={closeForm}
              className="btn-soft focus-ring rounded-xl px-4 py-2.5 text-sm font-medium text-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
            >
              {pending ? "Updating…" : "Change password"}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

export function AppearanceCard() {
  const { compact } = useTheme();

  return (
    <Card>
      <CardHeader title="Appearance" />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Theme</p>
          {/* True on the screen it is being read on. This said "Day, Evening,
              then Night" everywhere, which stopped being true on a phone the
              moment Evening became a desktop-only palette — a sentence
              describing behaviour the reader's own device does not have. */}
          <p className="mt-0.5 text-xs text-faint">
            {compact
              ? "Auto follows the time of day — Day, then Night."
              : "Auto follows the time of day — Day, Evening, then Night."}
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
  const [addOpen, openAdd, closeAdd] = useFormDisclosure(createState, (st) => Boolean(st?.ok));

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

      {/*
          Adding a client is behind the same disclosure as the password and the
          invitation, and for the same reason: it is a rare action, and its two
          empty fields plus their explanation sat under the list on every visit
          — on a phone that is more of the screen than the list itself.
      */}
      {canManage && (
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          {!addOpen ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              {createState ? (
                <div className="min-w-0 flex-1">
                  <Banner state={createState} />
                </div>
              ) : (
                <p className="min-w-0 flex-1 text-xs text-faint">
                  {atLimit
                    ? `Your plan covers ${limit} workspace${limit === 1 ? "" : "s"}. Upgrade under Billing to add more.`
                    : "Add another client and their records start empty and separate."}
                </p>
              )}
              <button
                type="button"
                onClick={openAdd}
                className="btn-accent focus-ring flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold"
              >
                <Plus className="h-4 w-4" />
                Add workspace
              </button>
            </div>
          ) : (
            <form action={create} className="space-y-4">
              <Banner state={createState} />
              <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-2">
                <Field label="Client name" name="name" required />
                <Field label="Phone number (optional)" name="phoneNumber" />
              </div>
              <p className="text-xs text-faint">
                A number routes that client&apos;s inbound calls to their own workspace. It has to be
                unique, because a call can only belong to one of them.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeAdd}
                  className="btn-soft focus-ring rounded-xl px-4 py-2.5 text-sm font-medium text-muted"
                >
                  Cancel
                </button>
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
        </div>
      )}
    </Card>
  );
}

export { BillingCard, type BillingView } from "@/components/billing/BillingCard";

/* ---------------- bits ---------------- */

/**
 * The hours this workspace is open, which is what a booking page offers.
 *
 * Two decisions worth stating, because both are about not inventing anything.
 *
 * A day with its checkbox off is CLOSED and stores no row — an absent row and a
 * row saying "open: false" would be two ways to say one thing, and they would
 * eventually disagree. So turning a day off is the same act as never turning it
 * on, which is why the times stay on screen, greyed, rather than vanishing: the
 * person can see what Saturday would be if they switched it back.
 *
 * And a workspace that has set nothing shows nothing set. The form OPENS on a
 * suggested Monday-to-Friday because seven empty rows is a worse starting
 * point, but the notice above it says plainly that nothing is stored yet —
 * until Save is pressed, the suggestion is ours, not theirs, and nothing reads
 * it when deciding what is bookable.
 */
export function WorkingHoursCard({
  week,
  timeZone,
}: {
  week: OpenDay[];
  timeZone: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    updateWorkingHoursAction,
    undefined
  );

  const configured = week.length > 0;
  /* The suggestion fills the FORM, never the store. `configured` above is what
     everything else keys off. */
  const shown = configured ? week : SUGGESTED_WEEK;

  return (
    <Card className="card-q">
      <CardHeader
        title="Opening hours"
        icon={<Clock className="h-[18px] w-[18px] text-accent" />}
      />
      <form action={action} className="space-y-4">
        <Banner state={state} />

        {!configured && (
          <p
            className="rounded-xl px-3.5 py-2.5 text-xs"
            style={{ background: "var(--amber-soft)", color: "var(--amber)" }}
          >
            No hours are set yet, so nothing can be booked. Below is a suggested
            week — change it to yours and press Save.
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          {WEEKDAYS.map((name, weekday) => {
            const day = hoursFor(shown, weekday);
            const open = Boolean(day);
            return (
              <div
                key={name}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2.5 py-2 @min-[420px]:grid-cols-[minmax(0,7rem)_auto_auto]"
                style={{ background: "var(--sunken)" }}
              >
                <label className="flex min-w-0 items-center gap-2.5">
                  <input
                    type="checkbox"
                    name={`open-${weekday}`}
                    defaultChecked={open}
                    className="focus-ring h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="truncate text-sm font-medium">{name}</span>
                </label>
                <div className="col-span-2 flex items-center gap-2 @min-[420px]:col-span-1 @min-[420px]:justify-end">
                  <input
                    type="time"
                    name={`opens-${weekday}`}
                    defaultValue={formatClock(day?.opensMinute ?? 8 * 60)}
                    aria-label={`${name} opens`}
                    className="field-input w-full max-w-[7.5rem] tabular-nums"
                  />
                  <span className="text-xs text-faint">to</span>
                  <input
                    type="time"
                    name={`closes-${weekday}`}
                    defaultValue={formatClock(day?.closesMinute ?? 17 * 60)}
                    aria-label={`${name} closes`}
                    className="field-input w-full max-w-[7.5rem] tabular-nums"
                  />
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-xs text-faint">
          Times are local to {timeZone.replace(/_/g, " ")}, the zone set under Targets &amp;
          capacity. Unticked days are closed. Public holidays are set separately below and close a
          day whatever these say.
        </p>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={pending}
            className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save hours"}
          </button>
        </div>
      </form>
    </Card>
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

/**
 * The days this workspace does not work.
 *
 * Weekends are a rule the scheduler already knows; these are data it cannot
 * guess. A day added here moves every project task that would have crossed it —
 * which is why the card says so rather than presenting itself as a list nobody
 * reads.
 *
 * The importer fills a year from a country's public holidays. It is a
 * convenience for filling the list, not a source the schedule trusts: the dates
 * land in this workspace's own table, where any of them can be removed.
 */
export function HolidaysCard({
  holidays,
  thisYear,
}: {
  holidays: { id: string; onDate: string; name: string }[];
  /** Resolved on the server against the business's zone, not the device's. */
  thisYear: number;
}) {
  const [addState, add, adding] = useActionState<FormState, FormData>(addHolidayAction, undefined);
  const [importState, importYear, importing] = useActionState<FormState, FormData>(
    importHolidaysAction,
    undefined
  );
  const [removeState, remove] = useActionState<FormState, FormData>(
    removeHolidayAction,
    undefined
  );

  /* Grouped by year, newest first, because a calendar with three years in it is
     three lists rather than one of forty rows. */
  const byYear = new Map<string, typeof holidays>();
  for (const h of holidays) {
    const year = h.onDate.slice(0, 4);
    const bucket = byYear.get(year);
    if (bucket) bucket.push(h);
    else byYear.set(year, [h]);
  }
  const years = [...byYear.keys()].sort().reverse();

  return (
    <Card>
      <CardHeader
        title="Working calendar"
        icon={<CalendarOff className="h-[18px] w-[18px] text-accent" />}
        action={<CardMeta value={holidays.length}>{holidays.length === 1 ? "day" : "days"}</CardMeta>}
      />
      <p className="mb-4 text-xs text-muted">
        Days this workspace is closed. Project schedules skip them, the same way they skip
        weekends — so adding one moves any task that would have run across it.
      </p>

      <div className="flex flex-col gap-2 empty:hidden">
        <Banner state={addState} />
        <Banner state={importState} />
        <Banner state={removeState} />
      </div>

      <form action={importYear} className="mt-3 flex flex-wrap items-end gap-2">
        <input type="hidden" name="setId" value="za" />
        <label className="w-28">
          <span className="mb-1.5 block text-xs font-medium text-muted">Year</span>
          <input
            type="number"
            name="year"
            min="2020"
            max="2100"
            defaultValue={thisYear}
            className="field-input"
          />
        </label>
        <button
          type="submit"
          disabled={importing}
          className="btn-soft focus-ring rounded-xl px-4 py-2.5 text-sm font-medium disabled:opacity-60"
        >
          {importing ? "Adding…" : "Add South African holidays"}
        </button>
      </form>

      <form action={add} className="mt-3 flex flex-wrap items-end gap-2 border-t border-[var(--border)] pt-3">
        <label className="w-40">
          <span className="mb-1.5 block text-xs font-medium text-muted">Date</span>
          <input type="date" name="onDate" required className="field-input" />
        </label>
        <label className="min-w-0 flex-1">
          <span className="mb-1.5 block text-xs font-medium text-muted">What it is</span>
          <input name="name" placeholder="Company shutdown" required className="field-input" />
        </label>
        <button
          type="submit"
          disabled={adding}
          className="btn-accent focus-ring rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
        >
          Add a day
        </button>
      </form>

      {holidays.length === 0 ? (
        <p className="mt-4 text-xs text-faint">
          Nothing yet — schedules currently skip weekends only.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {years.map((year) => (
            <div key={year}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
                {year}
              </p>
              <ul className="flex flex-col gap-1.5">
                {(byYear.get(year) ?? []).map((h) => (
                  <li
                    key={h.id}
                    className="flex items-center gap-3 rounded-xl px-3 py-2"
                    style={{ background: "var(--surface-2)" }}
                  >
                    <span className="w-24 shrink-0 text-xs tabular-nums text-muted">
                      {readableHoliday(h.onDate)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{h.name}</span>
                    <form action={remove} className="shrink-0">
                      <input type="hidden" name="id" value={h.id} />
                      <button
                        type="submit"
                        aria-label={`Remove ${h.name}`}
                        className="btn-soft focus-ring rounded-lg p-2 text-muted transition-colors hover:text-red"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** "24 Sep · Thu" — the weekday matters here: it says why a day costs the plan
    anything at all, since a Saturday closure changes nothing. */
function readableHoliday(iso: string): string {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const [y, m, d] = iso.split("-").map(Number);
  /* Built as UTC and read as UTC, so the weekday cannot slip in a zone behind
     Greenwich — the same rule every other date on this project follows. */
  const weekday = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${d} ${MONTHS[m - 1]} · ${weekday}`;
}
