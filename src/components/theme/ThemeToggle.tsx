"use client";

import { Moon, MoonStar, Sun, SunMoon } from "lucide-react";
import { useTheme } from "./ThemeProvider";
import { MODE_ORDER, MODE_ORDER_COMPACT, THEME_LABELS } from "@/lib/theme";

/*
   Midnight was `Stars`, which is a four-pointed sparkle — the same shape as the
   assistant's `Sparkles`, sitting two buttons away in the same header. On a
   phone the theme label is hidden, so both were unlabelled blue sparkles side
   by side and there was nothing to tell them apart. Reported exactly that way.

   `MoonStar` says late night without borrowing the assistant's mark, and the
   whole set now reads as one family about the sky: sun, moon, sun-and-moon,
   moon-and-star. Nothing in it looks like AI.
*/
const ICON = {
  auto: SunMoon,
  light: Sun,
  dark: Moon,
  midnight: MoonStar,
} as const;

export function ThemeToggle() {
  const { mode, level, setMode, compact } = useTheme();
  const Icon = ICON[mode];

  /*
     A phone offers Day, Night and Auto — three taps round the loop instead of
     four, and no stop on a palette it does not paint. Evening is a desktop
     refinement; see `levelForViewport`.
  */
  const order = compact ? MODE_ORDER_COMPACT : MODE_ORDER;

  const cycle = () => {
    /*
       `indexOf` can miss, and that is the case worth handling rather than
       ignoring: a phone syncing a desktop that chose Evening has a mode which
       is not in its own order, and `(-1 + 1) % 3` would land back on Auto —
       silently discarding a choice the moment the loop is touched. Falling
       through to the next palette the phone DOES offer keeps the tap
       predictable.
    */
    const idx = order.indexOf(mode);
    setMode(idx === -1 ? "midnight" : order[(idx + 1) % order.length]);
  };

  const title =
    mode === "auto"
      ? `Theme: Auto (following the clock — now ${THEME_LABELS[level]})`
      : `Theme: ${THEME_LABELS[mode]}`;

  return (
    <button
      type="button"
      onClick={cycle}
      title={title}
      aria-label={title}
      className="btn-soft focus-ring group flex h-10 items-center gap-2 rounded-full px-3 text-sm font-medium"
    >
      <Icon className="h-[18px] w-[18px] text-accent transition-transform group-hover:rotate-12" />
      <span className="hidden sm:inline">{THEME_LABELS[mode]}</span>
    </button>
  );
}
