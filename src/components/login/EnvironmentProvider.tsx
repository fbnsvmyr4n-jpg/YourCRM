"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { EnvironmentClock, estimateLocationFromClock } from "@/lib/environment/clock";
import { publishToElement } from "@/lib/environment/publish";
import { resolveLocation } from "@/lib/solar/location";
import type { Coordinates } from "@/lib/solar/types";

/**
 * Runs the environment clock and hands its numbers to the CSS cascade.
 *
 * This component renders **once**. Everything that moves afterwards moves
 * through custom properties written straight onto the DOM — so no ancestor of
 * the sign-in form re-renders when the sun moves, and the form cannot lose
 * focus or remount mid-sunset. §16 asks for that; here it falls out of the
 * architecture rather than being defended.
 *
 * Nothing below it is allowed to block authentication. The clock starts on an
 * estimate derived from the device's own time zone — no permission, no network
 * — and real coordinates ease in later if they ever arrive. If every rung of
 * the location ladder fails, the environment is merely less accurate, and the
 * form was usable the entire time.
 */

const ClockContext = createContext<EnvironmentClock | null>(null);

/** The running clock, for the developer panel. Null outside the provider. */
export function useEnvironmentClock(): EnvironmentClock | null {
  return useContext(ClockContext);
}

export function EnvironmentProvider({ children }: { children: React.ReactNode }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const clockRef = useRef<EnvironmentClock | null>(null);
  // State only so the panel can be handed the clock once it exists. It changes
  // exactly once, on mount — never per frame.
  const [clock, setClock] = useState<EnvironmentClock | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const engine = new EnvironmentClock({
      // The device clock's estimate, available immediately. See
      // `estimateLocationFromClock` for why this beats waiting.
      location: estimateLocationFromClock(),
      publish: (state) => publishToElement(host, state),
      reducedMotion: motion.matches,
    });

    clockRef.current = engine;
    engine.start();
    setClock(engine);

    /**
     * Subscribed, not read once.
     *
     * The existing starfield reads `prefers-reduced-motion` at mount and never
     * again, so switching it on mid-session does nothing until a reload. A
     * preference about motion should take effect when it is expressed.
     */
    const onMotionChange = (event: MediaQueryListEvent) => engine.setReducedMotion(event.matches);
    motion.addEventListener("change", onMotionChange);

    /**
     * A backgrounded tab is throttled, then returns.
     *
     * §11: reconcile with the actual current timestamp rather than replaying
     * stale animation. A laptop closed at dusk and opened at breakfast must
     * show breakfast — not ease through the night it slept through.
     */
    const onVisible = () => {
      if (document.visibilityState === "visible") engine.snap();
    };
    document.addEventListener("visibilitychange", onVisible);

    /**
     * Real coordinates, if they come.
     *
     * Deliberately not awaited before starting: the ladder can take seconds and
     * may need a permission prompt, and the sign-in form is not waiting for a
     * backdrop. When they land, `setLocation` does NOT snap — the environment
     * eases from the estimate to the truth, which §18 asks for in as many
     * words: no jarring visual teleportation.
     */
    let cancelled = false;
    resolveLocation()
      .then((where: Coordinates) => {
        if (!cancelled) engine.setLocation(where);
      })
      // `resolveLocation` is built never to reject. This is here anyway, because
      // an unhandled rejection while resolving the decoration behind a login
      // form would be an absurd way to break a sign-in.
      .catch(() => {});

    return () => {
      cancelled = true;
      motion.removeEventListener("change", onMotionChange);
      document.removeEventListener("visibilitychange", onVisible);
      engine.stop();
    };
  }, []);

  return (
    <ClockContext.Provider value={clock}>
      {/*
        The properties land here and inherit down. `display: contents` so this
        wrapper takes part in nothing — it exists to hold custom properties and
        must not introduce a box that changes any layout beneath it.
      */}
      <div ref={hostRef} style={{ display: "contents" }} data-environment>
        {children}
      </div>
    </ClockContext.Provider>
  );
}
