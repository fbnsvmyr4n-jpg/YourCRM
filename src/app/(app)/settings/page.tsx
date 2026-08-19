import { redirect } from "next/navigation";
import { Database, HardDrive, ShieldAlert, ShieldCheck } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Card, CardHeader } from "@/components/ui/Card";
import { authSecretConfigured } from "@/server/auth";
import { getSettings } from "@/server/repos/settings";
import { currentUser, withCurrentTenant } from "@/server/tenant-session";
import { storageEngine } from "@/server/store";
import {
  AppearanceCard,
  PasswordForm,
  ProfileForm,
  SignOutCard,
  TargetsForm,
} from "./SettingsForms";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const engine = storageEngine();
  const secretOk = authSecretConfigured();
  const settings = await withCurrentTenant((q) => getSettings(q));

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
