"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsLeft, ChevronDown, LogOut } from "lucide-react";
import { visibleNav } from "./nav";
import { Logo, Wordmark } from "./Logo";
import { signOutAction } from "@/app/(auth)/actions";
import { clsx } from "@/lib/clsx";
import { useWords } from "./Vocabulary";
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
  crmAccess,
  moneyAccess,
}: {
  user: ShellUser;
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  counts: NavCounts;
  /** Decided on the server. False for IT and accounts. */
  crmAccess: boolean;
  /** May this reader open quotations, orders and invoices. */
  moneyAccess: boolean;
}) {
  const pathname = usePathname();
  const nav = visibleNav(crmAccess, moneyAccess);
  /* Two rows are named by the workspace rather than by this file: the list of
     work and the board of stages. Everything else means the same thing in
     every trade. */
  const words = useWords();
  const labelFor = (item: { label: string }) =>
    item.label === "Projects" ? words.area : item.label === "Deals" ? words.board : item.label;
  const [menuOpen, setMenuOpen] = useState(false);
  /*
     Groups the reader has opened or closed by hand, by parent href.

     Only the ones they TOUCHED. Everything else falls back to "open if this is
     where you are", so the sidebar still arranges itself around the current
     page and a deliberate choice still wins over it. An empty object on every
     load is correct: this is a decision about the next few seconds, not a
     preference worth remembering across sessions.
  */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  return (
    <aside
      className={clsx(
        "glass fixed inset-y-0 left-0 z-40 flex h-full flex-col rounded-none border-y-0 border-l-0 py-5 duration-300 ease-out",
        /* `print:hidden` — navigation printed alongside a quotation is the
           clearest sign a document was screenshotted rather than issued. */
        "transition-transform lg:static lg:z-20 lg:translate-x-0 lg:transition-[width] print:hidden",
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
        {nav.map((section, i) => (
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
                /* The parent row does not light up for a child's page —
                   /quotes is not /projects — so the group counts as open
                   when the parent OR any child is where the reader is. */
                const childrenOpen =
                  active || (item.children?.some((c) => isActive(pathname, c.href)) ?? false);
                /* Where the reader is, unless they have said otherwise. */
                const expanded = toggled[item.href] ?? childrenOpen;
                const hasChildren = Boolean(item.children?.length) && !collapsed;
                const Icon = item.icon;
                // The config names a count; the value comes from the database.
                const unread =
                  item.count === "inbox" ? counts.inbox : item.count === "tasksDue" ? counts.tasksDue : 0;
                const today = item.count === "calendarToday" && counts.calendarToday;
                return (
                  <li key={item.href}>
                    {/* The row is a link AND, where there are nested pages, a
                        disclosure beside it — two controls, because they do two
                        things. Nesting a button inside the link would also be
                        invalid markup. */}
                    <div className="relative flex items-center">
                    <Link
                      href={item.href}
                      onClick={onMobileClose}
                      title={collapsed ? labelFor(item) : undefined}
                      className={[
                        "focus-ring group relative flex w-full items-center rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
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
                      {/* `pr-6` only where a chevron sits over the row, so a
                          long label truncates before it reaches the control
                          rather than sliding underneath it. */}
                      {!collapsed && (
                        <span className={clsx("relative z-10 flex-1 truncate", hasChildren && "pr-6")}>
                          {labelFor(item)}
                        </span>
                      )}
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

                    {/* Says the nested pages exist, and opens them where you
                        stand.

                        Without it the only evidence that Quotes and Purchase
                        orders exist at all was arriving on Projects — so
                        reaching a quote from anywhere else in the product cost
                        a navigation to a page nobody wanted, purely to find the
                        link to the one they did. The chevron is the whole fix:
                        it marks the row as having more under it, and opens that
                        without going anywhere. */}
                    {hasChildren && (
                      <button
                        type="button"
                        onClick={() => setToggled((t) => ({ ...t, [item.href]: !expanded }))}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Hide" : "Show"} pages under ${labelFor(item)}`}
                        className="focus-ring absolute right-1 z-20 rounded-lg p-1.5 text-faint transition-colors hover:text-[var(--text)]"
                      >
                        <ChevronDown
                          className={clsx("h-4 w-4 transition-transform", expanded && "rotate-180")}
                          aria-hidden
                        />
                      </button>
                    )}
                    </div>

                    {/* Nested pages. Never while collapsed, where there is no
                        room to say what they are.

                        Open by where the reader IS — arriving on /quotes should
                        not leave the sidebar looking like nothing is selected —
                        and now also openable by hand, which is what the chevron
                        above does. The hand-made choice wins while it lasts;
                        navigating to another area goes back to following the
                        page, because `toggled` is keyed by this row alone. */}
                    {hasChildren && expanded ? (
                      <ul className="mt-0.5 space-y-0.5 pl-[30px]">
                        {item.children!.map((child) => {
                          const childActive = isActive(pathname, child.href);
                          const ChildIcon = child.icon;
                          return (
                            <li key={child.href}>
                              <Link
                                href={child.href}
                                onClick={onMobileClose}
                                className={[
                                  "focus-ring relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors",
                                  childActive
                                    ? "font-medium text-accent"
                                    : "text-muted hover:text-[var(--text)]",
                                ].join(" ")}
                              >
                                <ChildIcon className="h-[15px] w-[15px] shrink-0" />
                                <span>{child.label}</span>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
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
