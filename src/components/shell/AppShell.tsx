"use client";

import { useState } from "react";
import { CurrencyProvider } from "@/components/money/CurrencyProvider";
import { canSettleInvoice, canWrite, isViewOnly } from "@/server/permissions";
import { CanWriteProvider } from "./CanWrite";
import { MaySettleProvider } from "./MaySettle";
import { AbilitiesProvider } from "./Abilities";
import { VocabularyProvider } from "./Vocabulary";
import type { CurrencyCode } from "@/lib/money";
import type { VocabularyId } from "@/data/vocabulary";
import type { NavCounts } from "@/server/nav-counts";
import type { Notification } from "@/server/notifications";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import type { NavAccess } from "./nav";
import { Topbar } from "./Topbar";

export type ShellUser = { name: string; role: string; initials: string; email: string };

export function AppShell({
  children,
  user,
  notifications,
  counts,
  access,
  currency,
  vocabulary,
}: {
  children: React.ReactNode;
  user: ShellUser;
  notifications: Notification[];
  counts: NavCounts;
  /**
   * Which tiers this reader holds, decided on the server. Presentation only —
   * what actually stops an IT admin opening /contacts is `withTenantPage`.
   *
   * ONE OBJECT, not four booleans in a row. They were four, and four of
   * anything threaded through two components in a fixed order is a prop
   * somebody passes in the wrong slot — `crmAccess={crmAccess}
   * moneyAccess={moneyAccess} mailAccess={mailAccess}` is three chances to
   * silently hand a bookkeeper the pipeline. A fifth door is now a field, which
   * cannot be mis-ordered and cannot be half-forwarded.
   */
  access: NavAccess;
  /** The workspace's currency, for every amount on every page below. */
  currency: CurrencyCode;
  /** What this workspace calls its work — see `data/vocabulary.ts`. */
  vocabulary: VocabularyId;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <CurrencyProvider currency={currency}>
    {/* One answer for every control underneath: a viewer is offered nothing
        the database will refuse. See `CanWrite`. */}
    <CanWriteProvider canWrite={canWrite(user.role)}>
    {/* And one answer for the payment box: confirming money arrived is
        finance's desk, not the salesperson's. See `MaySettle`. */}
    <MaySettleProvider maySettle={canSettleInvoice(user.role)}>
    {/* One answer per door, so a mail screen asks about mail and a money
        screen asks about money — see `Abilities`. */}
    <AbilitiesProvider
      mail={access.mail && !isViewOnly(user.role)}
      money={access.money && !isViewOnly(user.role)}
      ops={access.ops && !isViewOnly(user.role)}
    >
    <VocabularyProvider vocabulary={vocabulary}>
    {/* The `print:` overrides are on the shell, not on the page inside it: the app
        is a fixed-height clipped box with its own scroller, which is right on
        screen and prints exactly one screenful — the rest of a long document
        silently missing, which is the worst way for this to fail. On paper the
        height is whatever the content needs. */}
    <div className="relative z-[1] flex h-screen overflow-hidden print:block print:h-auto print:overflow-visible">
      <Sidebar
        user={user}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        counts={counts}
        access={access}
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
          crmAccess={access.crm}
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
        <main className="@container flex-1 scroll-p-2 overflow-y-auto px-5 pb-8 pt-1 sm:px-7 print:overflow-visible print:p-0">
          {/* Said once, before anything is attempted. The database refuses a
              view-only person's changes regardless; this is so nobody types a
              paragraph first to find out. */}
          {isViewOnly(user.role) && (
            <p
              role="status"
              className="mx-auto mb-3 max-w-[1500px] rounded-xl px-4 py-2.5 text-sm font-medium print:hidden"
              style={{ background: "var(--amber-soft)", color: "var(--amber)" }}
            >
              View only — you can see everything here, and changes are not saved.
            </p>
          )}
          {children}
        </main>
      </div>

      <CommandPalette />
    </div>
    </VocabularyProvider>
    </AbilitiesProvider>
    </MaySettleProvider>
    </CanWriteProvider>
    </CurrencyProvider>
  );
}
