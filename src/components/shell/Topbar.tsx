"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Bell,
  CalendarClock,
  ChevronDown,
  DollarSign,
  Mail,
  Menu,
  MessageSquare,
  Phone,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { signOutAction } from "@/app/(auth)/actions";
import type { Notification, NotificationKind } from "@/server/notifications";
import { clsx } from "@/lib/clsx";
import type { ShellUser } from "./AppShell";
import { OPEN_COMMAND_EVENT } from "./CommandPalette";

function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_COMMAND_EVENT));
}

const KIND_ICON: Record<NotificationKind, typeof Bell> = {
  meeting: CalendarClock,
  lead: UserPlus,
  message: Mail,
  call: Phone,
  deal: DollarSign,
};
const KIND_TONE: Record<NotificationKind, string> = {
  meeting: "var(--red)",
  lead: "var(--amber)",
  message: "var(--accent)",
  call: "var(--purple)",
  deal: "var(--green)",
};

/** Closes a popover on outside click and on Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export function Topbar({
  onMenu,
  user,
  notifications,
}: {
  onMenu?: () => void;
  user: ShellUser;
  notifications: Notification[];
}) {
  const [bellOpen, setBellOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const bellRef = useDismiss(bellOpen, () => setBellOpen(false));
  const menuRef = useDismiss(menuOpen, () => setMenuOpen(false));

  return (
    <header className="sticky top-0 z-20 flex items-center gap-3 px-5 py-4 sm:gap-4 sm:px-7">
      <button
        type="button"
        aria-label="Open menu"
        onClick={onMenu}
        className="btn-soft focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-2xl lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <button
        type="button"
        onClick={openCommandPalette}
        aria-label="Search"
        className="card focus-ring relative flex h-12 flex-1 items-center gap-3 rounded-2xl pl-12 pr-3 text-left"
        style={{ borderRadius: 16 }}
      >
        <Search className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-faint" />
        <span className="flex-1 truncate text-sm text-faint">Search contacts, companies, deals...</span>
        <kbd className="hidden items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[11px] font-medium text-faint sm:flex">
          ⌘ K
        </kbd>
      </button>

      <ThemeToggle />

      {/* Was a dead "Analytics" button. Now the shortcut to the assistant,
          reachable from every page. */}
      <Link
        href="/chat"
        aria-label="Ask the AI assistant"
        title="Ask the AI assistant"
        className="btn-soft focus-ring hidden h-10 w-10 place-items-center rounded-full sm:grid"
      >
        <Sparkles className="h-[18px] w-[18px] text-accent" />
      </Link>

      {/* Notifications — everything that needs attention, nothing filtered. */}
      <div className="relative" ref={bellRef}>
        <button
          type="button"
          aria-label={`Notifications${notifications.length ? ` (${notifications.length})` : ""}`}
          aria-expanded={bellOpen}
          onClick={() => setBellOpen((v) => !v)}
          className="btn-soft focus-ring relative grid h-10 w-10 place-items-center rounded-full"
        >
          <Bell className="h-[18px] w-[18px]" />
          {notifications.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--red)] px-1 text-[10px] font-bold text-white">
              {notifications.length > 99 ? "99+" : notifications.length}
            </span>
          )}
        </button>

        {bellOpen && (
          <div className="card absolute right-0 top-12 z-30 w-[min(92vw,380px)] overflow-hidden p-0">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <p className="text-sm font-semibold">Notifications</p>
              <span className="text-xs text-faint">
                {notifications.length === 0 ? "All clear" : `${notifications.length} needing attention`}
              </span>
            </div>

            {notifications.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-faint">
                Nothing needs your attention right now.
              </p>
            ) : (
              <div className="max-h-[min(60vh,420px)] overflow-y-auto">
                {notifications.map((n) => {
                  const Icon = KIND_ICON[n.kind];
                  return (
                    <Link
                      key={n.id}
                      href={n.href}
                      onClick={() => setBellOpen(false)}
                      className="flex items-start gap-3 border-b border-[var(--border)] px-4 py-3 transition-colors last:border-b-0 hover:bg-[var(--raise)]"
                    >
                      <span
                        className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                        style={{ background: "var(--raise)", color: KIND_TONE[n.kind] }}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block truncate text-sm font-medium">{n.title}</span>
                        <span className="mt-0.5 block truncate text-xs text-faint">{n.detail}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Account — the signed-in user, with sign-out where they expect it. */}
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          className="btn-soft focus-ring flex items-center gap-2.5 rounded-full py-1 pl-1 pr-2.5"
        >
          <span className="accent-gradient grid h-9 w-9 place-items-center rounded-full text-[13px] font-semibold text-white">
            {user.initials}
          </span>
          <span className="hidden text-left leading-tight sm:block">
            <span className="block max-w-[140px] truncate text-sm font-semibold">{user.name}</span>
            <span className="block text-xs text-faint">{user.role}</span>
          </span>
          <ChevronDown
            className={clsx("hidden h-4 w-4 text-faint transition-transform sm:block", menuOpen && "rotate-180")}
          />
        </button>

        {menuOpen && (
          <div className="card absolute right-0 top-12 z-30 w-60 overflow-hidden p-0">
            <div className="border-b border-[var(--border)] px-4 py-3 leading-tight">
              <p className="truncate text-sm font-semibold">{user.name}</p>
              <p className="mt-0.5 truncate text-xs text-faint">{user.email}</p>
            </div>
            <Link
              href="/settings"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors hover:bg-[var(--raise)]"
            >
              <SettingsIcon className="h-4 w-4 text-faint" /> Settings
            </Link>
            <Link
              href="/chat"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors hover:bg-[var(--raise)]"
            >
              <MessageSquare className="h-4 w-4 text-faint" /> Ask the assistant
            </Link>
            <form action={signOutAction} className="border-t border-[var(--border)]">
              <button
                type="submit"
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-red transition-colors hover:bg-[var(--raise)]"
              >
                Sign out
              </button>
            </form>
          </div>
        )}
      </div>
    </header>
  );
}
