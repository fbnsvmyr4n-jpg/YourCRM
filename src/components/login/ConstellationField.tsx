"use client";

import { useEffect, useRef } from "react";

/**
 * The interactive layer behind the sign-in card.
 *
 * A drifting particle field that reacts to the cursor: nearby stars are drawn
 * toward it and brighten, and any two stars close enough get linked by a line
 * whose opacity falls off with distance — the constellation effect. Three
 * depth bands move at different rates and parallax against the pointer, which
 * is what sells the sense of space.
 *
 * Canvas rather than DOM: this is ~140 moving elements plus a few hundred
 * lines per frame, which would pin the main thread as divs.
 *
 * It is decorative, so it never blocks the form — `pointer-events: none`, and
 * `aria-hidden`. It also stops completely for `prefers-reduced-motion` and
 * whenever the tab is hidden, so it can't quietly burn a laptop battery on a
 * page people leave open.
 */

type Star = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 0 = far, 1 = near. Drives size, brightness and parallax strength. */
  depth: number;
  r: number;
  /** Phase offset so the twinkle isn't synchronised across the field. */
  phase: number;
};

const LINK_DISTANCE = 132;
const CURSOR_RADIUS = 190;
const MAX_DPR = 2;

/**
 * The two pieces of maths that define how this feels, pulled out as pure
 * functions so they can be exercised without a browser. The animation itself
 * only runs inside `requestAnimationFrame`, which never fires in a backgrounded
 * tab — so the rendering genuinely cannot be asserted headlessly, but the
 * behaviour that drives it can.
 */

/** How strongly the cursor affects a point: 0 outside the radius, 1 at the centre. */
export function cursorInfluence(dist: number, radius = CURSOR_RADIUS): number {
  if (dist >= radius || dist < 0) return 0;
  return (1 - dist / radius) ** 2;
}

/** Opacity of the line between two stars `d` apart, with `lift` from the cursor. */
export function linkOpacity(d: number, lift = 0, max = LINK_DISTANCE): number {
  if (d >= max) return 0;
  const fade = 1 - d / max;
  return fade * fade * (0.16 + lift * 0.5);
}

export function ConstellationField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let stars: Star[] = [];
    let raf = 0;
    let running = true;

    // Target follows the real pointer; `cur` eases toward it every frame so
    // motion feels fluid instead of snapping to each mousemove event.
    const target = { x: -9999, y: -9999 };
    const cur = { x: -9999, y: -9999 };
    let hasPointer = false;

    function build() {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = canvas!.clientWidth;
      height = canvas!.clientHeight;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Scale count to area so a large monitor isn't sparse and a phone isn't
      // needlessly busy.
      const count = Math.round(Math.min(170, Math.max(46, (width * height) / 12000)));
      stars = Array.from({ length: count }, () => {
        const depth = Math.random();
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * (0.08 + depth * 0.14),
          vy: (Math.random() - 0.5) * (0.08 + depth * 0.14),
          depth,
          r: 0.5 + depth * 1.5,
          phase: Math.random() * Math.PI * 2,
        };
      });
    }

    function frame(time: number) {
      if (!running) return;

      cur.x += (target.x - cur.x) * 0.08;
      cur.y += (target.y - cur.y) * 0.08;

      ctx!.clearRect(0, 0, width, height);

      // Parallax: the field slides opposite the pointer, further for nearer
      // bands. Small numbers on purpose — past a few pixels it reads as drift.
      const px = hasPointer ? (cur.x / width - 0.5) : 0;
      const py = hasPointer ? (cur.y / height - 0.5) : 0;

      const drawn = stars.map((s) => {
        s.x += s.vx;
        s.y += s.vy;

        // Wrap rather than bounce, so there is no visible edge behaviour.
        if (s.x < -20) s.x = width + 20;
        if (s.x > width + 20) s.x = -20;
        if (s.y < -20) s.y = height + 20;
        if (s.y > height + 20) s.y = -20;

        const shift = 10 + s.depth * 26;
        let x = s.x - px * shift;
        let y = s.y - py * shift;

        // Cursor gravity — a gentle pull, eased so the edge of the radius
        // isn't a hard boundary.
        let glow = 0;
        if (hasPointer) {
          const dx = cur.x - x;
          const dy = cur.y - y;
          const dist = Math.hypot(dx, dy);
          if (dist > 0.001) {
            const pull = cursorInfluence(dist);
            x += dx * pull * 0.22;
            y += dy * pull * 0.22;
            glow = pull;
          }
        }

        const twinkle = 0.72 + Math.sin(time * 0.0013 + s.phase) * 0.28;
        const alpha = Math.min(1, (0.2 + s.depth * 0.55) * twinkle + glow * 0.75);
        return { x, y, r: s.r, alpha, glow, depth: s.depth };
      });

      // Links first, so stars sit on top of their own connections.
      ctx!.lineWidth = 1;
      for (let i = 0; i < drawn.length; i++) {
        for (let j = i + 1; j < drawn.length; j++) {
          const a = drawn[i];
          const b = drawn[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK_DISTANCE * LINK_DISTANCE) continue;

          const d = Math.sqrt(d2);
          // Links near the cursor pick up the accent colour and strengthen.
          const lift = Math.max(a.glow, b.glow);
          const opacity = linkOpacity(d, lift);
          ctx!.strokeStyle = lift > 0.04
            ? `rgba(96, 165, 250, ${opacity})`
            : `rgba(180, 200, 235, ${opacity * 0.75})`;
          ctx!.beginPath();
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
          ctx!.stroke();
        }
      }

      for (const s of drawn) {
        if (s.glow > 0.02) {
          const halo = ctx!.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 9);
          halo.addColorStop(0, `rgba(125, 211, 252, ${0.36 * s.glow})`);
          halo.addColorStop(1, "rgba(125, 211, 252, 0)");
          ctx!.fillStyle = halo;
          ctx!.beginPath();
          ctx!.arc(s.x, s.y, s.r * 9, 0, Math.PI * 2);
          ctx!.fill();
        }
        ctx!.fillStyle = s.glow > 0.25
          ? `rgba(219, 240, 255, ${s.alpha})`
          : `rgba(233, 240, 255, ${s.alpha})`;
        ctx!.beginPath();
        ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx!.fill();
      }

      // A soft light where the cursor is, tying the whole field together.
      if (hasPointer) {
        const g = ctx!.createRadialGradient(cur.x, cur.y, 0, cur.x, cur.y, CURSOR_RADIUS * 1.15);
        g.addColorStop(0, "rgba(56, 132, 255, 0.10)");
        g.addColorStop(0.55, "rgba(6, 182, 212, 0.045)");
        g.addColorStop(1, "rgba(6, 182, 212, 0)");
        ctx!.fillStyle = g;
        ctx!.fillRect(0, 0, width, height);
      }

      raf = requestAnimationFrame(frame);
    }

    function onPointer(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      target.x = e.clientX - rect.left;
      target.y = e.clientY - rect.top;
      if (!hasPointer) {
        // Start eased motion from the entry point rather than sweeping in
        // from the off-screen sentinel.
        cur.x = target.x;
        cur.y = target.y;
        hasPointer = true;
      }
    }
    function onLeave() {
      hasPointer = false;
      target.x = -9999;
      target.y = -9999;
    }
    function onVisibility() {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        raf = requestAnimationFrame(frame);
      }
    }

    build();

    if (reduceMotion) {
      // One static frame: the field still looks composed, nothing moves.
      ctx.clearRect(0, 0, width, height);
      for (const s of stars) {
        ctx.fillStyle = `rgba(233, 240, 255, ${0.2 + s.depth * 0.5})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    // A ResizeObserver, not just the window resize event: on first paint the
    // canvas is briefly laid out at its intrinsic size, so sizing the backing
    // store in the effect body alone can capture the wrong dimensions and
    // leave the field stretched until something else happens to trigger a
    // resize. The observer fires as soon as the real box is known.
    const ro = new ResizeObserver(() => build());
    ro.observe(canvas);

    const onResize = () => build();
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", onPointer, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(frame);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 1 }}
    />
  );
}
