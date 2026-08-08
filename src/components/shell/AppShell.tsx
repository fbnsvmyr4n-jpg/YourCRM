"use client";

import { useState } from "react";
import type { Notification } from "@/server/notifications";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export type ShellUser = { name: string; role: string; initials: string; email: string };

export function AppShell({
  children,
  user,
  notifications,
}: {
  children: React.ReactNode;
  user: ShellUser;
  notifications: Notification[];
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="relative z-[1] flex h-screen overflow-hidden">
      <Sidebar
        user={user}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setMobileOpen(true)} user={user} notifications={notifications} />
        <main className="flex-1 overflow-y-auto px-5 pb-8 sm:px-7">{children}</main>
      </div>

      <CommandPalette />
    </div>
  );
}
