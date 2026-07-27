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
  resolveLevel,
  THEME_STORAGE_KEY,
  type ThemeLevel,
  type ThemeMode,
} from "@/lib/theme";

type ThemeContextValue = {
  mode: ThemeMode;
  level: ThemeLevel;
  setMode: (mode: ThemeMode) => void;
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

  const level = useMemo<ThemeLevel>(() => {
    void minuteTick; // re-resolve when the clock ticks
    return resolveLevel(mode);
  }, [mode, minuteTick]);

  // Sync the resolved palette to the DOM (external system, no state involved).
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", level);
  }, [level]);

  const setMode = useCallback((next: ThemeMode) => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    window.dispatchEvent(new Event(MODE_EVENT));
  }, []);

  const value = useMemo(() => ({ mode, level, setMode }), [mode, level, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
