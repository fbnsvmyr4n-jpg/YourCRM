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
    /*
       Tighter gutters below `sm`, and only below `sm`.

       Once the row could actually shrink, the search collapsed to 62px on a
       320px screen because the padding and gaps were eating 88px of it. Both
       are mobile-only overrides, so every width from 640px up is byte-for-byte
       what it was.
    */
    <header className="sticky top-0 z-20 flex items-center gap-2 px-3 py-4 sm:gap-4 sm:px-7">
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
        /*
           `min-w-0` is not decoration — without it this row breaks the whole app
           on a narrow phone.

           `flex-1` is `flex: 1 1 0%`, but a flex item's AUTOMATIC MINIMUM SIZE
           is `min-width: auto`, which resolves to its min-content width. This
           button carries 60px of padding, so its minimum was never small enough
           to fit, and rather than shrinking it pushed everything after it off
           the screen. Measured at 320px: the search rendered 292px wide and the
           avatar's right edge landed at 540 — 220px past the viewport — with the
           shell clipping it, so there was not even a scrollbar to reach it.
           Every screen in the app showed a cut-off search bar because every
           screen shares this header.

           It is also inert on desktop by construction: a minimum only binds when
           there is not enough room, and above `sm` there always is.
        */
        /*
           Below 390px this is an icon button, not a field.

           There is no width under 390 where a labelled search survives beside a
           menu, a theme toggle, an assistant, a bell and an avatar. Measured
           with all six present: at 320 the field is 44px and at 360 it is 88 —
           against 60px of its own padding, so the label had 2px and 28px to
           live in and rendered as "Sea…". That is the layout looking broken
           rather than adapted, which is exactly how it was reported.

           So under 390 it stops pretending to be a field: same size as the menu
           button beside it, glyph centred, no label. Above 390 the label has
           58px and fits, and every rule here switches off — from 390 up this is
           byte-for-byte the header it always was.
        */
        className="card focus-ring relative flex h-11 w-11 shrink-0 min-w-0 items-center justify-center gap-3 rounded-2xl text-left min-[390px]:h-12 min-[390px]:w-auto min-[390px]:flex-1 min-[390px]:shrink min-[390px]:justify-start min-[390px]:pl-12 min-[390px]:pr-3"
        style={{ borderRadius: 16 }}
      >
        <Search className="pointer-events-none absolute left-1/2 top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 text-faint min-[390px]:left-4 min-[390px]:translate-x-0" />
        {/*
            Below 400px the placeholder is dropped rather than truncated.

            There is no width at which "Search contacts, companies, deals..."
            fits on a 320px phone alongside a menu, a theme toggle, a bell and an
            avatar — it can only ever render as "Search c…", which reads as a
            layout that broke rather than one that adapted. Without it the
            control is a full-width field with a search glyph, which is what a
            phone expects anyway and is a far bigger tap target.
        */}
        <span className="hidden flex-1 truncate text-sm text-faint min-[390px]:block">
          {/*
              A shorter label rather than a truncated one.

              "Search contacts, companies, deals..." cannot fit on a 320px phone
              beside a menu, a theme toggle, a bell and an avatar — there is only
              about 80px left for text, so it can only render as "Search cont…",
              which reads as a layout that broke rather than one that adapted.
              Dropping it entirely was the first attempt and that was worse: it
              left a blank field on the iPhone 15 and 16, which are 393pt and so
              land under any 400px threshold.

              So the label shortens instead of vanishing. Both spans carry the
              same styling; only one is ever displayed.

              740, not 420. The long form was swapped in at 420 and does not fit
              there, or anywhere near it: measured, it needs 237px of text box
              and gets 88 at 420, 161 at 660 and 201 at 700. So from 420 all the
              way past the desktop breakpoint it rendered as "Search contacts,
              compa…" — the truncation this whole block exists to avoid, just at
              a width nobody thought to check. It first fits at 736; 740 is the
              round number above that.
          */}
          <span className="min-[740px]:hidden">Search</span>
          <span className="hidden min-[740px]:inline">Search contacts, companies, deals...</span>
        </span>
        <kbd className="hidden items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5 text-[11px] font-medium text-faint sm:flex">
          ⌘ K
        </kbd>
      </button>

      {/*
          `ml-auto` takes up the slack the search no longer absorbs.

          Below 390 the search is a fixed-width button, so nothing in the row
          grows and the controls would pack to the left with a gap after the
          avatar. This pushes the cluster back to the right edge. It is inert
          from 390 up — the search is `flex-1` again there, free space is zero,
          and `auto` margins have nothing to distribute.
      */}
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-4">
        <ThemeToggle />

      {/* Was a dead "Analytics" button. Now the shortcut to the assistant,
          reachable from every page.

          It was `sm:grid`, which meant it did not exist below 640px — so on
          every phone the header showed a theme toggle where two buttons were
          expected, and the assistant had no shortcut at all. On a product whose
          headline feature is the assistant, hiding it on the device most people
          carry is the wrong trade.

          360px rather than 640: the budget is tight but real. Below `sm` the
          chrome needs 284px with this button present, so at 320px the search
          would be squeezed to 36px — narrower than its own icon — while at
          360px it still has 76px and at 393px, which is the iPhone 15 and 16,
          it has 109px. Every current iPhone clears 360; only the oldest SE
          does not, and there it is the search that must win. */}
      <Link
        href="/chat"
        aria-label="Ask the AI assistant"
        title="Ask the AI assistant"
        /*
           Present at every width, and never squashed.

           `min-[360px]:grid` still hid it on the narrowest phones — and on a
           393pt iPhone with Display Zoom turned on, which reports a 320px
           viewport, so a current handset lost the assistant entirely. That is
           how it was reported: the shortcut simply missing from the header.

           It was also missing a `shrink-0`. Measured at 320 with it unhidden,
           flex shrank it to 26px — a tap target well under the 44px minimum,
           and a circle visibly smaller than the bell beside it. Unhiding alone
           would have produced a button that was there but wrong.

           The room comes from the search, which stops being a field below 390
           and becomes an icon button the same size as the menu. Nothing is
           lost: it opens the same command palette, with a bigger tap target
           than the label it gave up.
        */
        /*
           Filled, not another soft grey circle.

           The icon was changed away from a second sparkle, but likeness was
           only half the problem: this sat in a row of identical neutral
           buttons — menu, search, theme, bell — as one more of them, and on a
           phone none of them carry a label. Being the same SHAPE as its
           neighbours is what made it confusable, not just the same glyph.

           It is the shortcut to the product's headline feature, so it is the
           one control in this row that should look like a destination. Filled
           accent does that at a glance and cannot be mistaken for a toggle.
        */
        className="btn-accent focus-ring grid h-10 w-10 shrink-0 place-items-center rounded-full"
      >
        <Sparkles className="h-[18px] w-[18px]" />
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
          /*
              Pinned to the screen on a phone, to the bell on a desktop.

              `absolute right-0` anchors the panel's right edge to the BELL, and
              the bell is not at the right edge of the screen — the avatar sits
              after it. Measured at 320: the bell's right edge is at 260 and the
              panel is 294 wide (92vw), so it started at -34 and the first 34px
              of every row — the word "Notifications", the icon, the start of
              each title — were off the side of the screen with no way to reach
              them. Half a notification is not a notification.

              Below `sm` it is `fixed` with equal gutters instead, which pins it
              to the viewport rather than to whatever control opened it: 12 to
              308 at 320px wide. Verified that no ancestor establishes a
              containing block for fixed positioning — no transform, filter,
              backdrop-filter, perspective, contain or will-change anywhere up
              the tree — so this resolves against the viewport, not the header.

              From `sm` up every one of these is switched back off and the panel
              is exactly the one it always was.
          */
          <div className="popover fixed left-3 right-3 top-[72px] z-30 overflow-hidden p-0 sm:absolute sm:left-auto sm:right-0 sm:top-12 sm:w-[min(92vw,380px)]">
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
              <div className="max-h-[min(60dvh,420px)] overflow-y-auto">
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
          /*
             Symmetric padding once the label is gone.

             `pl-1 pr-2.5` is right when the name and chevron follow the avatar:
             the extra 6px on the right balances the text. Below `sm` both of
             those are `hidden`, so the padding was wrapping a lone 36px circle
             in 4px on the left and 10px on the right — the avatar sat 3px left
             of the button's own centre, and the button rendered 50px wide next
             to a 40px bell, so it also broke the rhythm of the row it ends.
             Below `sm` it becomes a fixed 40px circle — the bell's exact size,
             so the three round controls that end the row are one rhythm rather
             than 40, 40, 46.
          */
          className="btn-soft focus-ring flex h-10 w-10 items-center justify-center gap-2.5 rounded-full p-0 sm:h-auto sm:w-auto sm:justify-start sm:py-1 sm:pl-1 sm:pr-2.5"
        >
          <span className="accent-gradient grid h-8 w-8 place-items-center rounded-full text-[13px] font-semibold text-white sm:h-9 sm:w-9">
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
          <div className="popover absolute right-0 top-12 z-30 w-60 overflow-hidden p-0">
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
      </div>
    </header>
  );
}
