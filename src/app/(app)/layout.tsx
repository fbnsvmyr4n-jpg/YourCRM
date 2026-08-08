import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { listNotifications } from "@/server/notifications";
import { getCurrentUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  // Route guard: every screen inside (app) requires a valid session.
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Derived on the server from live records, so the bell is accurate the
  // moment any page renders rather than depending on a client fetch.
  const notifications = await listNotifications();

  return (
    <AppShell user={user} notifications={notifications}>
      {children}
    </AppShell>
  );
}
