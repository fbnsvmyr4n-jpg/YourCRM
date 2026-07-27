import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { getCurrentUser } from "@/server/session";

export default async function AppGroupLayout({ children }: { children: React.ReactNode }) {
  // Route guard: every screen inside (app) requires a valid session.
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return <AppShell user={user}>{children}</AppShell>;
}
