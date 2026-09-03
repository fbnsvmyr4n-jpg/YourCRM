"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  COMPACT_QUERY,
  levelForViewport,
  resolveLevel,
  THEME_STORAGE_KEY,
  type ThemeLevel,
  type ThemeMode,
} from "@/lib/theme";

type ThemeContextValue = {
  mode: ThemeMode;
  level: ThemeLevel;
  setMode: (mode: ThemeMode) => void;
  /** True on a phone, where the palette set is Day and Night only. */
  compact: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Fired in-tab when the mode changes (the `storage` event only fires cross-tab). */
const MODE_EVENT = "yourcrm-theme-mode-change";

function subscribeMode(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(MODE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(MODE_EVENT, onChange);
  };
}

/**
 * Whether this is a phone-width screen.
 *
 * A media query is an external store, so it is subscribed to rather than read
 * during render — the same treatment `localStorage` gets above, and for the
 * same reason: reading it mid-render is impure and would not update on a
 * rotate or a resize.
 */
function subscribeCompact(onChange: () => void) {
  const mq = window.matchMedia(COMPACT_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function readCompact(): boolean {
  return window.matchMedia(COMPACT_QUERY).matches;
}

/* The server has no viewport. False keeps the server's markup identical to the
   desktop case; the pre-paint script in the root layout sets the real attribute
   before anything is drawn, so nothing flashes either way. */
function readServerCompact(): boolean {
  return false;
}

function readMode(): ThemeMode {
  return (localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null) ?? "auto";
}

/** The server can't read storage; the pre-paint script in the root layout covers the flash. */
function readServerMode(): ThemeMode {
  return "auto";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // localStorage is an external store — subscribing avoids a setState-in-effect hydration pass.
  const mode = useSyncExternalStore(subscribeMode, readMode, readServerMode);

  // In auto mode the palette follows the clock, so re-resolve on a minute cadence.
  const [minuteTick, setMinuteTick] = useState(0);
  useEffect(() => {
    if (mode !== "auto") return;
    const id = window.setInterval(() => setMinuteTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [mode]);

  const compact = useSyncExternalStore(subscribeCompact, readCompact, readServerCompact);

  const level = useMemo<ThemeLevel>(() => {
    void minuteTick; // re-resolve when the clock ticks
    /* Collapsed for a phone, where Evening is not one of the two palettes on
       offer — see `levelForViewport`. */
    return levelForViewport(resolveLevel(mode), compact);
  }, [mode, minuteTick, compact]);

  // Sync the resolved palette to the DOM (external system, no state involved).
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", level);
  }, [level]);

  const setMode = useCallback((next: ThemeMode) => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    window.dispatchEvent(new Event(MODE_EVENT));
  }, []);

  const value = useMemo(
    () => ({ mode, level, setMode, compact }),
    [mode, level, setMode, compact]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
