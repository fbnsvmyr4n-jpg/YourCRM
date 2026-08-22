"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsLeft, ChevronDown, LogOut } from "lucide-react";
import { NAV } from "./nav";
import { Logo, Wordmark } from "./Logo";
import { signOutAction } from "@/app/(auth)/actions";
import { clsx } from "@/lib/clsx";
import type { ShellUser } from "./AppShell";
import type { NavCounts } from "@/server/nav-counts";

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function Sidebar({
  user,
  collapsed,
  onToggle,
  mobileOpen,
  onMobileClose,
  counts,
}: {
  user: ShellUser;
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  counts: NavCounts;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <aside
      className={clsx(
        "glass fixed inset-y-0 left-0 z-40 flex h-full flex-col rounded-none border-y-0 border-l-0 py-5 duration-300 ease-out",
        "transition-transform lg:static lg:z-20 lg:translate-x-0 lg:transition-[width]",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}
      style={{ width: collapsed ? 84 : 264 }}
    >
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 pb-5">
        <Logo />
        {!collapsed && <Wordmark />}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3">
        {NAV.map((section, i) => (
          <div key={i} className="mb-1.5">
            {section.heading && !collapsed && (
              <p className="px-3 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                {section.heading}
              </p>
            )}
            {section.heading && collapsed && <div className="my-2 h-px bg-[var(--border)]" />}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = isActive(pathname, item.href);
                const Icon = item.icon;
                // The config names a count; the value comes from the database.
                const unread = item.count === "inbox" ? counts.inbox : 0;
                const today = item.count === "calendarToday" && counts.calendarToday;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onMobileClose}
                      title={collapsed ? item.label : undefined}
                      className={[
                        "focus-ring group relative flex items-center rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                        collapsed ? "justify-center" : "gap-3",
                        active
                          ? "text-[var(--text)]"
                          : "text-muted hover:text-[var(--text)]",
                      ].join(" ")}
                    >
                      {active && (
                        <span
                          className="absolute inset-0 rounded-xl border border-[var(--border-strong)]"
                          style={{ background: "var(--accent-soft)" }}
                        />
                      )}
                      <Icon
                        className={[
                          "relative z-10 h-[19px] w-[19px] shrink-0",
                          active ? "text-accent" : "",
                        ].join(" ")}
                      />
                      {!collapsed && <span className="relative z-10 flex-1">{item.label}</span>}
                      {/* Nothing waiting, nothing shown. A badge reading 0 is
                          an invitation to check something that is already
                          clear. */}
                      {!collapsed && unread > 0 && (
                        <span className="relative z-10 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-accent">
                          {unread > 99 ? "99+" : unread}
                        </span>
                      )}
                      {!collapsed && today && (
                        <span className="relative z-10 h-2 w-2 rounded-full bg-[var(--purple)]" />
                      )}
                      {collapsed && (unread > 0 || today) && (
                        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--accent)]" />
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* User card */}
      <div className="relative mt-2 px-3">
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div
              className="absolute bottom-full left-3 right-3 z-20 mb-2 overflow-hidden rounded-xl border border-[var(--border)] py-1 shadow-lg"
              style={{ background: "var(--panel-solid)" }}
            >
              {!collapsed && (
                <p className="truncate px-3 py-2 text-xs text-faint">{user.email}</p>
              )}
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red transition-colors hover:bg-[var(--raise)]"
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </button>
              </form>
            </div>
          </>
        )}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="btn-soft focus-ring flex w-full items-center gap-3 rounded-2xl p-2.5 text-left"
        >
          <span className="accent-gradient grid h-9 w-9 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-white">
            {user.initials}
          </span>
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-sm font-semibold">{user.name}</span>
                <span className="block text-xs text-faint">{user.role}</span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-faint" />
            </>
          )}
        </button>
      </div>

      {/* Collapse (desktop only) */}
      <div className="hidden px-3 pt-3 lg:block">
        <button
          type="button"
          onClick={onToggle}
          // Collapsed, the word is gone and only the chevron remains, which
          // leaves the control with no accessible name at all.
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          className="focus-ring flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted transition-colors hover:text-[var(--text)]"
        >
          <ChevronsLeft
            className={`h-[19px] w-[19px] shrink-0 transition-transform duration-300 ${
              collapsed ? "rotate-180" : ""
            }`}
          />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
