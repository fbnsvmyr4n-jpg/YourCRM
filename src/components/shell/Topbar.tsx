"use client";

import { BarChart3, Bell, ChevronDown, Menu, Search } from "lucide-react";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { OPEN_COMMAND_EVENT } from "./CommandPalette";

function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_COMMAND_EVENT));
}

export function Topbar({ onMenu }: { onMenu?: () => void }) {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-3 px-5 py-4 sm:gap-4 sm:px-7">
      {/* Mobile menu */}
      <button
        type="button"
        aria-label="Open menu"
        onClick={onMenu}
        className="btn-soft focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-2xl lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Search — opens the command palette */}
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

      <button
        type="button"
        aria-label="Analytics"
        className="btn-soft focus-ring hidden h-10 w-10 place-items-center rounded-full sm:grid"
      >
        <BarChart3 className="h-[18px] w-[18px]" />
      </button>

      <button
        type="button"
        aria-label="Notifications"
        className="btn-soft focus-ring relative grid h-10 w-10 place-items-center rounded-full"
      >
        <Bell className="h-[18px] w-[18px]" />
        <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--red)] px-1 text-[10px] font-bold text-white">
          3
        </span>
      </button>

      <button
        type="button"
        className="btn-soft focus-ring flex items-center gap-2.5 rounded-full py-1 pl-1 pr-2.5"
      >
        <span className="accent-gradient grid h-9 w-9 place-items-center rounded-full text-[13px] font-semibold text-white">
          LL
        </span>
        <span className="hidden text-left leading-tight sm:block">
          <span className="block text-sm font-semibold">Lang Lee</span>
          <span className="block text-xs text-faint">Admin</span>
        </span>
        <ChevronDown className="hidden h-4 w-4 text-faint sm:block" />
      </button>
    </header>
  );
}
