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
  /** Index into STAR_COLORS — real starfields are not uniformly white. */
  tint: number;
  /** The brightest few get diffraction spikes; most do not. */
  hero: boolean;
};

/**
 * Star colour by temperature, roughly following real stellar classes: mostly
 * white and blue-white, with a minority of warm yellow and amber. A field of
 * identical white dots is the single clearest tell that a starfield was
 * generated rather than photographed.
 */
const STAR_COLORS = [
  [214, 232, 255], // blue-white
  [236, 244, 255], // white
  [255, 246, 228], // warm white
  [255, 228, 190], // amber
  [198, 218, 255], // cool blue
] as const;

/** Weighted so warm stars stay a minority, as they are in a real sky. */
function pickTint(): number {
  const r = Math.random();
  if (r < 0.34) return 1;
  if (r < 0.62) return 0;
  if (r < 0.8) return 4;
  if (r < 0.93) return 2;
  return 3;
}

/**
 * Tuning. Deliberately fewer, larger, brighter stars than a typical particle
 * demo: the brief is high-end minimalist, and restraint plus a strong cursor
 * response reads as considered where a dense fizzing field reads as a
 * screensaver.
 */
const LINK_DISTANCE = 168;
const CURSOR_RADIUS = 300;
const MAX_DPR = 2;
/** Positions kept for the cursor wake, newest first. */
const TRAIL_LENGTH = 18;

/**
 * The slow colour wash behind the stars. Sine and cosine on different
 * frequencies give a path that never visibly repeats, so it reads as drifting
 * rather than looping.
 */
const AURORA = [
  { cx: 0.28, cy: 0.32, ax: 0.16, ay: 0.12, sx: 0.000045, sy: 0.000062, p: 0, r: 0.55, color: "rgba(56,132,255,0.13)" },
  { cx: 0.74, cy: 0.62, ax: 0.14, ay: 0.15, sx: 0.000037, sy: 0.000051, p: 2.1, r: 0.5, color: "rgba(34,211,238,0.10)" },
  { cx: 0.55, cy: 0.18, ax: 0.2, ay: 0.1, sx: 0.000029, sy: 0.000043, p: 4.2, r: 0.42, color: "rgba(139,92,246,0.09)" },
] as const;

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

/**
 * Link radius scaled to the viewport.
 *
 * A fixed radius is a bug on small screens: 168px spans nearly half a phone,
 * so almost every star connects to every other and the field turns into a
 * dense web instead of sparse constellations. Scaling by the diagonal keeps
 * the *visual* density constant across sizes.
 */
export function linkDistanceFor(width: number, height: number): number {
  return Math.min(LINK_DISTANCE, Math.max(78, Math.hypot(width, height) * 0.1));
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
    /** Link radius for the current viewport — see `linkDistanceFor`. */
    let linkDist = LINK_DISTANCE;
    let raf = 0;
    let running = true;

    // Target follows the real pointer; `cur` eases toward it every frame so
    // motion feels fluid instead of snapping to each mousemove event.
    const target = { x: -9999, y: -9999 };
    const cur = { x: -9999, y: -9999 };
    let hasPointer = false;
    /** Recent cursor positions, newest first — drawn as a fading wake. */
    const trail: { x: number; y: number }[] = [];

    function build() {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = canvas!.clientWidth;
      height = canvas!.clientHeight;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      linkDist = linkDistanceFor(width, height);

      // Scale count to area so a large monitor isn't sparse and a phone isn't
      // needlessly busy. Sparser than before — larger, brighter points with
      // longer links carry more presence than a dense field of specks.
      const count = Math.round(Math.min(110, Math.max(34, (width * height) / 20000)));
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
          tint: pickTint(),
          // Roughly one in nine. Spikes on everything looks like glitter;
          // spikes on a handful looks like a long exposure.
          hero: Math.random() < 0.11 && depth > 0.55,
        };
      });
    }

    function frame(time: number) {
      if (!running) return;

      // 0.14 rather than 0.08 — noticeably quicker to follow the pointer while
      // still easing. Above roughly 0.2 the smoothing stops reading as fluid
      // and starts snapping to each event.
      cur.x += (target.x - cur.x) * 0.14;
      cur.y += (target.y - cur.y) * 0.14;

      if (hasPointer) {
        trail.unshift({ x: cur.x, y: cur.y });
        if (trail.length > TRAIL_LENGTH) trail.pop();
      } else if (trail.length) {
        trail.pop();
      }

      ctx!.clearRect(0, 0, width, height);

      // Two very large, slow radials drifting on out-of-phase sine paths. This
      // is the "flow" underneath everything — at this scale and opacity it
      // registers as depth rather than as shapes you can point at.
      for (const a of AURORA) {
        const ax = width * (a.cx + Math.sin(time * a.sx + a.p) * a.ax);
        const ay = height * (a.cy + Math.cos(time * a.sy + a.p) * a.ay);
        const r = Math.max(width, height) * a.r;
        const g = ctx!.createRadialGradient(ax, ay, 0, ax, ay, r);
        g.addColorStop(0, a.color);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx!.fillStyle = g;
        ctx!.fillRect(0, 0, width, height);
      }

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
            x += dx * pull * 0.34;
            y += dy * pull * 0.34;
            glow = pull;
          }
        }

        const twinkle = 0.72 + Math.sin(time * 0.0013 + s.phase) * 0.28;
        const alpha = Math.min(1, (0.24 + s.depth * 0.6) * twinkle + glow * 0.85);
        // Stars swell as the cursor reaches them — the clearest single signal
        // that the field is responding to you.
        const r = s.r * (1 + glow * 1.5);
        return { x, y, r, alpha, glow, depth: s.depth, tint: s.tint, hero: s.hero };
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
          if (d2 > linkDist * linkDist) continue;

          const d = Math.sqrt(d2);
          // Links near the cursor pick up the accent colour and strengthen.
          const lift = Math.max(a.glow, b.glow);
          const opacity = linkOpacity(d, lift, linkDist);
          ctx!.strokeStyle = lift > 0.04
            ? `rgba(125, 190, 255, ${opacity})`
            : `rgba(180, 200, 235, ${opacity * 0.8})`;
          // Lines thicken slightly under the cursor so the constellation the
          // pointer is touching reads as a single connected shape.
          ctx!.lineWidth = 1 + lift * 0.8;
          ctx!.beginPath();
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
          ctx!.stroke();
        }
      }

      for (const s of drawn) {
        const [cr, cg, cb] = STAR_COLORS[s.tint];

        // Every star carries a faint bloom in its own colour — a bare dot
        // reads as a pixel, a dot with a halo reads as a light source.
        const bloomR = s.r * (s.hero ? 7 : 4.5) * (1 + s.glow * 1.6);
        const bloom = ctx!.createRadialGradient(s.x, s.y, 0, s.x, s.y, bloomR);
        bloom.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${s.alpha * (0.3 + s.glow * 0.5)})`);
        bloom.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
        ctx!.fillStyle = bloom;
        ctx!.beginPath();
        ctx!.arc(s.x, s.y, bloomR, 0, Math.PI * 2);
        ctx!.fill();

        // Diffraction spikes on the brightest handful — the four-point flare a
        // camera lens produces on a bright point source.
        if (s.hero) {
          const len = s.r * (9 + s.glow * 14);
          const a = s.alpha * (0.32 + s.glow * 0.4);
          ctx!.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${a})`;
          ctx!.lineWidth = 0.8;
          ctx!.lineCap = "round";
          ctx!.beginPath();
          ctx!.moveTo(s.x - len, s.y);
          ctx!.lineTo(s.x + len, s.y);
          ctx!.moveTo(s.x, s.y - len);
          ctx!.lineTo(s.x, s.y + len);
          ctx!.stroke();
        }

        ctx!.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${s.alpha})`;
        ctx!.beginPath();
        ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx!.fill();
      }

      // The wake — a comet tail of the cursor's recent path. Drawn after the
      // stars so it sits over them, and tapered so the oldest end vanishes.
      if (trail.length > 2) {
        for (let i = trail.length - 1; i > 0; i--) {
          const t0 = trail[i];
          const t1 = trail[i - 1];
          const k = 1 - i / trail.length;
          ctx!.strokeStyle = `rgba(140, 200, 255, ${k * k * 0.3})`;
          ctx!.lineWidth = k * 2.4;
          ctx!.lineCap = "round";
          ctx!.beginPath();
          ctx!.moveTo(t0.x, t0.y);
          ctx!.lineTo(t1.x, t1.y);
          ctx!.stroke();
        }
      }

      // A soft light where the cursor is, tying the whole field together.
      if (hasPointer) {
        const g = ctx!.createRadialGradient(cur.x, cur.y, 0, cur.x, cur.y, CURSOR_RADIUS * 1.15);
        g.addColorStop(0, "rgba(70, 150, 255, 0.16)");
        g.addColorStop(0.5, "rgba(34, 211, 238, 0.07)");
        g.addColorStop(1, "rgba(34, 211, 238, 0)");
        ctx!.fillStyle = g;
        ctx!.fillRect(0, 0, width, height);

        // A tight core right at the pointer, so the light has a source.
        const core = ctx!.createRadialGradient(cur.x, cur.y, 0, cur.x, cur.y, 46);
        core.addColorStop(0, "rgba(190, 225, 255, 0.3)");
        core.addColorStop(1, "rgba(190, 225, 255, 0)");
        ctx!.fillStyle = core;
        ctx!.beginPath();
        ctx!.arc(cur.x, cur.y, 46, 0, Math.PI * 2);
        ctx!.fill();
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
