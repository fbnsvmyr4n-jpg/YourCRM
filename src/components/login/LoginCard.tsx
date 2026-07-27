"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The glass card, with a light that tracks the cursor across its surface.
 *
 * Two layers do the work: a soft radial sheen inside the card, and a brighter
 * highlight riding the border — real glass catches light on its edge, and that
 * edge catch is most of what makes the effect read as expensive rather than as
 * a coloured blob.
 *
 * The pointer position is written to CSS custom properties and everything else
 * happens in CSS, so no React state updates and no re-renders on mousemove.
 * Updates are coalesced into an animation frame, since pointermove fires far
 * more often than the screen refreshes.
 */
export function LoginCard({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    let px = 0;
    let py = 0;
    let queued = false;

    function apply() {
      queued = false;
      const el2 = ref.current;
      if (!el2) return;
      const rect = el2.getBoundingClientRect();
      const x = ((px - rect.left) / rect.width) * 100;
      const y = ((py - rect.top) / rect.height) * 100;
      el2.style.setProperty("--mx", `${x}%`);
      el2.style.setProperty("--my", `${y}%`);

      // Fade the sheen out as the pointer leaves the card, rather than
      // switching it off at the boundary.
      const dx = Math.max(rect.left - px, 0, px - rect.right);
      const dy = Math.max(rect.top - py, 0, py - rect.bottom);
      const dist = Math.hypot(dx, dy);
      el2.style.setProperty("--glow", String(Math.max(0, 1 - dist / 260)));
    }

    function onMove(e: PointerEvent) {
      px = e.clientX;
      py = e.clientY;
      if (!queued) {
        queued = true;
        raf = requestAnimationFrame(apply);
      }
    }

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section ref={ref} className="login-card">
      {children}
    </section>
  );
}
