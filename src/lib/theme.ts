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

/**
 * Where "a phone" begins. Tailwind's `sm`, so this agrees with every
 * `sm:` class in the app rather than inventing a second idea of small.
 */
export const COMPACT_QUERY = "(max-width: 639px)";

/**
 * A phone has two palettes, not three.
 *
 * Evening is a gentle step between day and night, and on a desktop it earns
 * its place. On a phone it is a third near-identical dark that nobody asked
 * for — so there, Day and Night are the whole set and Evening collapses into
 * Night.
 *
 * Applied to the RESOLVED level rather than only to the picker, which is what
 * makes the claim true instead of nominal: without it, Auto would still land
 * on Evening between 18:00 and 21:00, and a mode chosen on a laptop would
 * still paint Evening on the phone that syncs it.
 *
 * The stored mode is left alone. Someone who picked Evening on their desktop
 * still has Evening there; the phone renders the nearest thing it offers,
 * rather than silently rewriting what they chose.
 */
export function levelForViewport(level: ThemeLevel, compact: boolean): ThemeLevel {
  return compact && level === "dark" ? "midnight" : level;
}

/** What the toggle cycles through. A phone drops Evening; a desktop keeps it. */
export const MODE_ORDER: ThemeMode[] = ["auto", "light", "dark", "midnight"];
export const MODE_ORDER_COMPACT: ThemeMode[] = ["auto", "light", "midnight"];
