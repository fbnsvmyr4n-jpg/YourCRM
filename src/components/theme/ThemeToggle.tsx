"use client";

import { Moon, Stars, Sun, SunMoon } from "lucide-react";
import { useTheme } from "./ThemeProvider";
import { THEME_LABELS, type ThemeMode } from "@/lib/theme";

const ORDER: ThemeMode[] = ["auto", "light", "dark", "midnight"];

const ICON = {
  auto: SunMoon,
  light: Sun,
  dark: Moon,
  midnight: Stars,
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
