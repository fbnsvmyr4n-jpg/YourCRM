export type ThemeLevel = "light" | "dark" | "midnight";
export type ThemeMode = "auto" | ThemeLevel;

export const THEME_STORAGE_KEY = "yourcrm-theme-mode";

/**
 * Map an hour (0-23) to a time-of-day palette.
 *  06:00–18:00 → light (daytime)
 *  18:00–21:00 → dark (evening, dims down)
 *  21:00–06:00 → midnight (deep night, darkest)
 */
export function levelForHour(hour: number): ThemeLevel {
  if (hour >= 6 && hour < 18) return "light";
  if (hour >= 18 && hour < 21) return "dark";
  return "midnight";
}

export function levelForDate(date: Date = new Date()): ThemeLevel {
  return levelForHour(date.getHours());
}

/** Resolve the concrete palette to apply, honoring a manual override. */
export function resolveLevel(mode: ThemeMode, date: Date = new Date()): ThemeLevel {
  return mode === "auto" ? levelForDate(date) : mode;
}

export const THEME_LABELS: Record<ThemeMode, string> = {
  auto: "Auto",
  light: "Day",
  dark: "Evening",
  midnight: "Night",
};
