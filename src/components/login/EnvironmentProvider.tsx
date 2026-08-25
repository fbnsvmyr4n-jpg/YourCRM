"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { EnvironmentClock, estimateLocationFromClock } from "@/lib/environment/clock";
import { clearFromElement, publishToElement } from "@/lib/environment/publish";
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
      /*
         Onto the ROOT, not onto the host.

         The host div was the obvious target and it was wrong, and nothing
         caught it for the entire life of this feature. `<OrbitScene />` is a
         SIBLING of the sign-in form, not an ancestor of it — so every
         `var(--env-card-text)`, `var(--env-scrim)` and the card's whole
         readability wash resolved to its fallback, permanently. The palette
         was computed correctly, published correctly, unit-tested correctly,
         and then delivered to a subtree the form was not in.

         The tests could not see it because they all measure the MODEL. There
         is no arithmetic error here to find; the numbers were always right.
         What was broken was who could read them.

         `<html>` is rendered by the root layout with no `style` prop, so React
         never touches the attribute — the same guarantee that made the host
         div safe — and everything in the document inherits from it, which the
         host could never offer.
      */
      publish: (state) => publishToElement(document.documentElement, state),
      reducedMotion: motion.matches,
      /**
       * The scene cuts itself back if this machine cannot keep up.
       *
       * An attribute rather than a property, because what it switches off is
       * whole effects — blurs, the ray fan, the density of the star field —
       * and those are selector-level decisions, not values to interpolate.
       */
      onLowPower: (low) => {
        document.documentElement.dataset.lowPower = low ? "true" : "false";
      },
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
      // See the publish target above: these live on `<html>` now, so they
      // outlast this component unless it takes them away again.
      clearFromElement(document.documentElement, engine.read());
    };
  }, []);

  return (
    <ClockContext.Provider value={clock}>
      {/*
        The host takes part in no layout, and no longer carries the palette.

        The properties go on `<html>` instead — see the publish call above for
        why — but the reason this wrapper has a CLASS rather than a `style`
        prop is unchanged and still worth stating, because the same trap
        applies to the new target.

        `display: contents` comes from a CLASS, not from a `style` prop, and
        that is not a style preference — it is a correctness fix. React owns the
        `style` attribute of any element it sets one on, and rewrites it in
        full on every render. The clock writes its custom properties to this
        same attribute imperatively, so a render — `setClock` below causes one,
        immediately after mount — silently wiped every one of them. What was
        left was the fallback palette: a night sky in broad daylight, restored
        only on the next animation frame, and not at all while the tab was
        hidden and frames were not being scheduled.

        With no `style` prop, React never touches the attribute and the
        properties survive. The wrapper still takes part in no layout.
      */}
      <div ref={hostRef} className="environment-host" data-environment>
        {children}
      </div>
    </ClockContext.Provider>
  );
}
