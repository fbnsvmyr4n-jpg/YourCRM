"use client";

import { Moon, MoonStar, Sun, SunMoon } from "lucide-react";
import { useTheme } from "./ThemeProvider";
import { THEME_LABELS, type ThemeMode } from "@/lib/theme";

const ORDER: ThemeMode[] = ["auto", "light", "dark", "midnight"];

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
  const { mode, level, setMode } = useTheme();
  const Icon = ICON[mode];

  const cycle = () => {
    const idx = ORDER.indexOf(mode);
    setMode(ORDER[(idx + 1) % ORDER.length]);
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
