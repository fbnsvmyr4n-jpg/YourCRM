import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { listNotifications } from "@/server/notifications";
import { currentUser, withCurrentTenant } from "@/server/tenant-session";

export const dynamic = "force-dynamic";

export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  // Route guard: every screen inside (app) requires a valid session.
  const user = await currentUser();
  if (!user) redirect("/login");

  // Derived on the server from live records, so the bell is accurate the
  // moment any page renders rather than depending on a client fetch. Read
  // inside the tenant, so it can only ever count this customer's work.
  const notifications = await withCurrentTenant((q) => listNotifications(q));

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
    >
      {children}
    </AppShell>
  );
}
