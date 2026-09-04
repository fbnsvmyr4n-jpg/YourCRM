"use client";

import { useState } from "react";
import {
  Building2,
  CreditCard,
  Database,
  SlidersHorizontal,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { clsx } from "@/lib/clsx";
import type { SettingsSectionId } from "./sections";

/**
 * Settings, as a place you navigate rather than a page you scroll.
 *
 * Measured before it was changed: eleven cards, 2,719px of content in a 720px
 * viewport. Nearly four screens, in an order nobody chose — profile, then
 * usage, then referrals, then billing, then workspaces, then targets, then the
 * bin, then a password form, then the theme. Finding the time zone meant
 * scrolling past the subscription and recognising a heading on the way down.
 *
 * So the cards are grouped into six areas and one is shown at a time. Every
 * area now fits on a screen, which is the standing rule for this product, and
 * the areas themselves are visible without opening any of them.
 *
 * Two shapes for the same thing, because a rail is a desktop idea:
 *
 *  - from 880px, a sticky left rail — the reader can see all six and where
 *    they are at once, and it puts the account identity in space the single
 *    column was wasting;
 *  - below it, a grid of chips in the language the Reports tabs already speak,
 *    two rows of three, so nothing wraps raggedly at one width and not another.
 *
 * Every section is rendered by the server with its data already in it and
 * hidden with CSS. Switching is instant and fetches nothing — the whole page
 * was one round trip either way, and making a tab into a navigation would have
 * turned it into six.
 */

const META: Record<SettingsSectionId, { label: string; icon: LucideIcon; blurb: string }> = {
  account: { label: "Account", icon: UserRound, blurb: "Your name, sign-in and password" },
  team: { label: "Team", icon: Users, blurb: "Who else can use this account" },
  workspaces: { label: "Workspaces", icon: Building2, blurb: "Your clients, kept separate" },
  preferences: { label: "Preferences", icon: SlidersHorizontal, blurb: "Targets, time zone and theme" },
  billing: { label: "Billing", icon: CreditCard, blurb: "Plan, usage and referrals" },
  data: { label: "Data", icon: Database, blurb: "Deleted records and storage" },
};

export function SettingsNav({
  user,
  initial,
  sections,
}: {
  user: { name: string; email: string; initials: string; role: string; planName: string };
  /**
   * Which area the URL asked for, already validated on the server.
   *
   * Read there rather than with `useSearchParams` here: that hook puts the
   * component behind the router's own Suspense boundary, so the server renders
   * a fallback and the right area only appears once the client has hydrated. As
   * a prop, the correct area is in the first HTML — and the constant it is
   * validated against has to live outside this file, because a server component
   * importing a value from a `"use client"` module gets a reference to the
   * module rather than the value. See `./sections`.
   */
  initial: SettingsSectionId;
  /** Server-rendered content, keyed by area. Order here is the order shown. */
  sections: { id: SettingsSectionId; content: React.ReactNode }[];
}) {
  /* `chosen` is the reader's own click since the page loaded, and wins over the
     URL — `replaceState` below deliberately does not re-run the router, so the
     prop stays at whatever the address said on arrival. */
  const [chosen, setChosen] = useState<SettingsSectionId | null>(null);
  const active: SettingsSectionId = chosen ?? initial;

  /* Not wrapped in `useCallback` — the React compiler memoises this, and a hand
     written one here it could not preserve made it skip the file entirely. */
  const select = (id: SettingsSectionId) => {
    setChosen(id);
    /*
       `replaceState`, not a router navigation. The page is `force-dynamic`, so
       pushing a route would re-run every query behind this screen to change
       which div is visible. This leaves a shareable URL and costs nothing.

       Guarded because a browser can refuse it (a sandboxed frame throws), and
       not being able to update the address bar is no reason to refuse to
       change tab.
    */
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("s", id);
      window.history.replaceState(null, "", url);
    } catch {
      /* The tab still changes. */
    }
  };

  return (
    <div className="@min-[880px]:grid @min-[880px]:grid-cols-[224px_minmax(0,1fr)] @min-[880px]:gap-6">
      {/* ---- the rail (desktop) ---- */}
      <div className="hidden @min-[880px]:block">
        <div className="sticky top-2 flex flex-col gap-4">
          <div className="card flex items-center gap-3 p-3.5">
            <Avatar initials={user.initials} color="blue" size="md" />
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold">{user.name}</p>
              <p className="truncate text-xs text-faint">{user.email}</p>
            </div>
          </div>

          <nav aria-label="Settings sections" className="flex flex-col gap-1">
            {sections.map(({ id }) => (
              <RailItem key={id} id={id} active={active === id} onSelect={select} />
            ))}
          </nav>

          {/* The two facts a settings screen is most often opened to check.
              Not a control: role and plan are changed elsewhere, under Team and
              Billing, and a chip that looked clickable here would be a lie. */}
          <div className="card flex flex-col gap-2 p-3.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-faint">Your role</span>
              <span className="font-semibold capitalize">{user.role}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-faint">Plan</span>
              <span className="font-semibold">{user.planName}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ---- the chips (phone and tablet) ---- */}
      <div className="@min-[880px]:hidden">
        <div className="grid grid-cols-3 gap-1.5">
          {sections.map(({ id }) => (
            <Chip key={id} id={id} active={active === id} onSelect={select} />
          ))}
        </div>
      </div>

      {/* ---- the areas ---- */}
      <div className="min-w-0">
        {sections.map(({ id, content }) => (
          <section
            key={id}
            id={`settings-${id}`}
            /* `hidden` as a class, not the attribute. `[hidden]` and `.flex`
               have the same specificity, so a `flex` utility on the same element
               wins by source order and the "hidden" section renders — a bug that
               looks like the tabs doing nothing at all. */
            className={clsx(
              "mt-4 flex-col gap-4 @min-[880px]:mt-0",
              active === id ? "flex" : "hidden"
            )}
          >
            {/* The area's own heading, and what it is for.

                On a phone the chip directly above is already lit and already
                says "Team", so a heading repeating it a line later is 34px of
                the screen spent saying the same word twice. It stays in the
                document for structure and for a screen reader, and becomes
                visible from 880px, where the label is off to the left in the
                rail rather than immediately overhead. The blurb earns its place
                on both. */}
            <div className="px-0.5">
              <h2 className="sr-only text-lg font-semibold tracking-tight @min-[880px]:not-sr-only">
                {META[id].label}
              </h2>
              <p className="text-xs text-faint @min-[880px]:mt-0.5">{META[id].blurb}</p>
            </div>
            {content}
          </section>
        ))}
      </div>
    </div>
  );
}

function RailItem({
  id,
  active,
  onSelect,
}: {
  id: SettingsSectionId;
  active: boolean;
  onSelect: (id: SettingsSectionId) => void;
}) {
  const { label, icon: Icon } = META[id];
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "focus-ring flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors",
        active ? "text-accent" : "text-muted hover:text-[var(--text)]"
      )}
      style={active ? { background: "var(--accent-soft)" } : undefined}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function Chip({
  id,
  active,
  onSelect,
}: {
  id: SettingsSectionId;
  active: boolean;
  onSelect: (id: SettingsSectionId) => void;
}) {
  const { label, icon: Icon } = META[id];
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-pressed={active}
      className={clsx(
        "focus-ring flex flex-col items-center gap-1.5 rounded-xl px-1.5 py-2.5 text-[11px] font-semibold transition-colors",
        active ? "text-accent" : "btn-soft text-muted"
      )}
      style={active ? { background: "var(--accent-soft)" } : undefined}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      <span className="w-full truncate text-center">{label}</span>
    </button>
  );
}
