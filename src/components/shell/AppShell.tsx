"use client";

import { useState } from "react";
import type { NavCounts } from "@/server/nav-counts";
import type { Notification } from "@/server/notifications";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export type ShellUser = { name: string; role: string; initials: string; email: string };

export function AppShell({
  children,
  user,
  notifications,
  counts,
  crmAccess,
}: {
  children: React.ReactNode;
  user: ShellUser;
  notifications: Notification[];
  counts: NavCounts;
  /** Decided on the server; false for IT and accounts. Presentation only. */
  crmAccess: boolean;
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
        counts={counts}
        crmAccess={crmAccess}
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
        <Topbar
          onMenu={() => setMobileOpen(true)}
          user={user}
          notifications={notifications}
          crmAccess={crmAccess}
        />
        {/* `@container` is what lets a page lay itself out against the room it
            actually has. A viewport media query can't see the sidebar, so a
            three-column grid switched on at 1024px was really being handed
            1024 − 264 (sidebar) − 56 (padding) = 704px, and the flexible middle
            column absorbed the entire shortfall. Sizing against this box instead
            means collapsing the rail genuinely widens the layout.

            Anything `position: fixed` inside here must be portalled — see
            `components/ui/Overlay`. */}
        {/* `scroll-p-2` is what stops focus rings being sliced off. Clicking or
            tabbing into a control scrolls it into view, and the browser parks it
            flush against this scroller's edge — where the 3px ring falls outside
            the scrollport and is clipped, so the highlight appears cut on one
            side. Scroll padding reserves room for it. */}
        <main className="@container flex-1 scroll-p-2 overflow-y-auto px-5 pb-8 pt-1 sm:px-7">{children}</main>
      </div>

      <CommandPalette />
    </div>
  );
}
