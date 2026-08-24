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

/** Sum of uniforms ≈ normal. Used to cluster stars toward the galactic plane. */
function gaussian(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

/**
 * Named constellation figures.
 *
 * Proximity-linking alone produces a uniform mesh — every neighbour joins
 * every neighbour, so nothing has a shape you could point at and name. Real
 * skies read as a handful of distinct *figures* against a loose field, so
 * these are drawn deliberately: unit coordinates, each with an explicit edge
 * list, placed at random position, scale and rotation on every load.
 *
 * Shapes are recognisable rather than accurate — the goal is variety the eye
 * can latch onto, not astronomy.
 */
type Figure = { pts: [number, number][]; edges: [number, number][] };

const FIGURES: Figure[] = [
  // Plough / Big Dipper — the pan and handle.
  {
    pts: [[0, 0.34], [0.2, 0.42], [0.4, 0.4], [0.42, 0.2], [0.62, 0.12], [0.82, 0.2], [1, 0.06]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [3, 0]],
  },
  // Cassiopeia — the W.
  {
    pts: [[0, 0.1], [0.25, 0.52], [0.5, 0.14], [0.75, 0.56], [1, 0.08]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  // Orion — belt with shoulders and feet.
  {
    pts: [[0.12, 0], [0.86, 0.06], [0.4, 0.44], [0.52, 0.5], [0.64, 0.56], [0.2, 1], [0.9, 0.96]],
    edges: [[0, 2], [1, 4], [2, 3], [3, 4], [2, 5], [4, 6], [0, 1]],
  },
  // Crux — the Southern Cross.
  {
    pts: [[0.5, 0], [0.5, 1], [0.14, 0.46], [0.9, 0.56]],
    edges: [[0, 1], [2, 3]],
  },
  // Lyra — small parallelogram with a bright apex.
  {
    pts: [[0.5, 0], [0.26, 0.42], [0.74, 0.5], [0.34, 0.94], [0.82, 1]],
    edges: [[0, 1], [0, 2], [1, 3], [2, 4], [3, 4]],
  },
  // A loose scatter triangle — deliberately irregular for variety.
  {
    pts: [[0, 0.2], [0.58, 0], [1, 0.44], [0.46, 0.9]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 0]],
  },
];

/** A figure placed on screen: absolute points plus the edges joining them. */
type PlacedFigure = { pts: { x: number; y: number; r: number; tint: number; phase: number }[]; edges: [number, number][] };

function placeFigures(width: number, height: number): PlacedFigure[] {
  // Scale the count to the viewport so a phone gets two and a wide monitor
  // gets a sky's worth, without ever crowding.
  const wanted = Math.max(2, Math.min(5, Math.round((width * height) / 380000)));
  const pool = [...FIGURES].sort(() => Math.random() - 0.5).slice(0, wanted);
  const short = Math.min(width, height);

  return pool.map((fig, i) => {
    const scale = short * (0.16 + Math.random() * 0.13);
    const angle = (Math.random() - 0.5) * 1.2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Spread across bands so two figures don't land on top of each other.
    const cx = width * (0.1 + ((i + Math.random() * 0.6) / wanted) * 0.82);
    const cy = height * (0.08 + Math.random() * 0.5);

    return {
      edges: fig.edges,
      pts: fig.pts.map(([ux, uy]) => {
        const x0 = (ux - 0.5) * scale;
        const y0 = (uy - 0.5) * scale;
        return {
          x: cx + x0 * cos - y0 * sin,
          y: cy + x0 * sin + y0 * cos,
          r: 0.9 + Math.random() * 1.1,
          tint: pickTint(),
          phase: Math.random() * Math.PI * 2,
        };
      }),
    };
  });
}

/**
 * Paints the Milky Way to an offscreen canvas, once per resize.
 *
 * In the reference photographs the galaxy is the *subject* — a bright band
 * with visible internal structure and dark dust lanes cutting through it — not
 * the faint corner smudge this scene had before.
 *
 * It is painted once and then blitted each frame with a small parallax offset.
 * Rebuilding several thousand clustered stars every frame would be pointless
 * work: the band itself never changes, only where it sits.
 */
function paintMilkyWay(w: number, h: number, plain = false): HTMLCanvasElement {
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const g = off.getContext("2d")!;

  // The band runs corner to corner. Work in a rotated frame so "along the
  // band" is simply +x and "across it" is +y.
  const angle = -0.62;
  const len = Math.hypot(w, h) * 1.3;
  const halfWidth = Math.min(w, h) * 0.3;

  g.save();
  g.translate(w * 0.5, h * 0.42);
  g.rotate(angle);

  // Diffuse glow of the band.
  const band = g.createLinearGradient(0, -halfWidth, 0, halfWidth);
  band.addColorStop(0, "rgba(120,150,215,0)");
  band.addColorStop(0.3, "rgba(140,165,225,0.055)");
  band.addColorStop(0.5, "rgba(190,190,225,0.085)");
  band.addColorStop(0.7, "rgba(140,165,225,0.055)");
  band.addColorStop(1, "rgba(120,150,215,0)");
  g.fillStyle = band;
  g.fillRect(-len / 2, -halfWidth, len, halfWidth * 2);

  // A warmer, denser core toward one end — the galactic centre.
  const core = g.createRadialGradient(-len * 0.12, 0, 0, -len * 0.12, 0, halfWidth * 1.5);
  core.addColorStop(0, "rgba(228,205,180,0.075)");
  core.addColorStop(0.5, "rgba(190,175,190,0.035)");
  core.addColorStop(1, "rgba(150,160,210,0)");
  g.fillStyle = core;
  g.fillRect(-len / 2, -halfWidth * 1.6, len, halfWidth * 3.2);

  // Dense field clustered on the plane. Falls off with distance from the
  // centreline, which is what gives the band a soft edge rather than a border.
  // Denser than before: the reference sky is thick with stars, and sparseness
  // was reading as empty rather than as restraint.
  const count = Math.round((w * h) / 520);
  for (let i = 0; i < count; i++) {
    const bx = (Math.random() - 0.5) * len;
    const spread = gaussian();
    const by = spread * halfWidth;
    const density = 1 - Math.min(1, Math.abs(spread));
    if (Math.random() > density * 0.95) continue;

    const r = Math.random() < 0.9 ? Math.random() * 0.55 + 0.18 : Math.random() * 1.1 + 0.5;
    const a = (0.18 + Math.random() * 0.5) * density;
    const [cr, cg, cb] = STAR_COLORS[pickTint()];
    g.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
    g.beginPath();
    g.arc(bx, by, r, 0, Math.PI * 2);
    g.fill();
  }

  // Nebula. The reference sky has a genuinely saturated magenta cloud rather
  // than a faint tint, so this is built from several overlapping blobs at
  // different scales — one big radial reads as a spotlight, a cluster of them
  // reads as gas.
  g.globalCompositeOperation = "screen";
  // A clear sky has no saturated gas cloud in it.
  const clouds = plain ? [] : [
    { x: -len * 0.3, y: -halfWidth * 0.5, r: halfWidth * 1.6, c: "rgba(206,54,196,0.42)" },
    { x: -len * 0.2, y: -halfWidth * 0.14, r: halfWidth * 1.2, c: "rgba(146,52,238,0.4)" },
    { x: -len * 0.38, y: halfWidth * 0.26, r: halfWidth * 0.95, c: "rgba(236,72,152,0.3)" },
    { x: -len * 0.1, y: -halfWidth * 0.7, r: halfWidth * 0.86, c: "rgba(116,72,255,0.34)" },
    { x: -len * 0.44, y: -halfWidth * 0.3, r: halfWidth * 0.62, c: "rgba(255,120,200,0.24)" },
    { x: len * 0.26, y: halfWidth * 0.32, r: halfWidth * 1.1, c: "rgba(74,116,255,0.24)" },
    { x: len * 0.42, y: -halfWidth * 0.36, r: halfWidth * 0.8, c: "rgba(60,190,230,0.18)" },
  ];
  for (const c of clouds) {
    const rg = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
    rg.addColorStop(0, c.c);
    rg.addColorStop(0.45, c.c.replace(/[\d.]+\)$/, "0.05)"));
    rg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rg;
    g.beginPath();
    g.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    g.fill();
  }
  // Filaments. Real nebulosity is wispy and threaded, not a set of clean
  // circles — a handful of soft strands across the clouds is what stops the
  // gas reading as airbrushed blobs.
  for (let i = 0; i < 14; i++) {
    const fx = -len * 0.45 + Math.random() * len * 0.55;
    const fy = (Math.random() - 0.5) * halfWidth * 1.6;
    const flen = halfWidth * (0.5 + Math.random() * 1.1);
    const drift = (Math.random() - 0.5) * 0.9;
    g.beginPath();
    g.moveTo(fx, fy);
    for (let t = 0; t <= 1.001; t += 0.2) {
      g.lineTo(fx + flen * t, fy + Math.sin(t * 3.4 + i) * halfWidth * 0.16 + drift * flen * t);
    }
    const hue = i % 3 === 0 ? "236,110,200" : i % 3 === 1 ? "150,90,240" : "110,150,255";
    g.strokeStyle = `rgba(${hue},${0.05 + Math.random() * 0.07})`;
    g.lineWidth = halfWidth * (0.05 + Math.random() * 0.12);
    g.lineCap = "round";
    g.filter = "blur(14px)";
    g.stroke();
    g.filter = "none";
  }

  g.globalCompositeOperation = "source-over";

  // Distant galaxies — small tilted ellipses with a bright nucleus. A real
  // deep field is full of them, and they are the cheapest single cue that
  // this is deep space rather than just a starry sky.
  for (let i = 0; i < 7; i++) {
    const gx = (Math.random() - 0.5) * len * 0.9;
    const gy = (Math.random() - 0.5) * halfWidth * 2.4;
    const rx = 3 + Math.random() * 9;
    const ry = rx * (0.24 + Math.random() * 0.4);
    g.save();
    g.translate(gx, gy);
    g.rotate(Math.random() * Math.PI);
    const halo = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    const warm = Math.random() < 0.5;
    halo.addColorStop(0, warm ? "rgba(255,238,214,0.5)" : "rgba(214,228,255,0.45)");
    halo.addColorStop(0.4, warm ? "rgba(255,214,170,0.16)" : "rgba(170,200,255,0.15)");
    halo.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = halo;
    g.beginPath();
    g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // Dust lanes — the dark rifts that split the band lengthways. Painted last,
  // punching back out through the stars, which is how they read in a photo.
  g.globalCompositeOperation = "destination-out";
  for (const lane of [
    { y: -halfWidth * 0.1, amp: halfWidth * 0.16, thick: halfWidth * 0.2, a: 0.5 },
    { y: halfWidth * 0.26, amp: halfWidth * 0.1, thick: halfWidth * 0.13, a: 0.34 },
    { y: -halfWidth * 0.42, amp: halfWidth * 0.12, thick: halfWidth * 0.1, a: 0.26 },
  ]) {
    g.beginPath();
    for (let x = -len / 2; x <= len / 2; x += len / 60) {
      const y = lane.y + Math.sin(x / (len / 7)) * lane.amp;
      if (x === -len / 2) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = `rgba(0,0,0,${lane.a})`;
    g.lineWidth = lane.thick;
    g.lineCap = "round";
    g.filter = "blur(6px)";
    g.stroke();
    g.filter = "none";
  }
  g.globalCompositeOperation = "source-over";
  g.restore();

  return off;
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

/**
 * `plain` drops the saturated nebula, the proximity links and the named
 * figures, leaving the stars, the soft band and the cursor parallax.
 *
 * The login screen's reference is a clear sky seen from orbit — a magenta gas
 * cloud and a web of joining lines are a different picture, and they compete
 * with the form. Everything that made the field feel alive is kept.
 */
export function ConstellationField({ variant = "constellations" }: { variant?: "constellations" | "plain" } = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const plain = variant === "plain";

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
    /** The Milky Way, painted once per resize and blitted each frame. */
    let galaxy: HTMLCanvasElement | null = null;
    /** Named constellation figures, re-placed on every resize. */
    let figures: PlacedFigure[] = [];
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
      galaxy = width > 0 && height > 0 ? paintMilkyWay(width, height, plain) : null;
      figures = !plain && width > 0 && height > 0 ? placeFigures(width, height) : [];

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

      // The galaxy sits behind everything, drifting only slightly with the
      // pointer — distant things should move least.
      if (galaxy) {
        const gx = hasPointer ? -(cur.x / width - 0.5) * 14 : 0;
        const gy = hasPointer ? -(cur.y / height - 0.5) * 10 : 0;
        ctx!.drawImage(galaxy, gx, gy);
      }

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
      for (let i = 0; plain ? false : i < drawn.length; i++) {
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

      // Named figures, drawn over the ambient field so their shape stays
      // legible against it. Brighter lines and larger stars than the loose
      // field, which is what makes them read as deliberate.
      for (const fig of figures) {
        const pts = fig.pts.map((pt) => {
          const shift = 16;
          let x = pt.x - px * shift;
          let y = pt.y - py * shift;
          let glow = 0;
          if (hasPointer) {
            const dx = cur.x - x;
            const dy = cur.y - y;
            const dist = Math.hypot(dx, dy);
            if (dist > 0.001) {
              const pull = cursorInfluence(dist);
              x += dx * pull * 0.28;
              y += dy * pull * 0.28;
              glow = pull;
            }
          }
          const tw = 0.78 + Math.sin(time * 0.0011 + pt.phase) * 0.22;
          return { x, y, r: pt.r * (1 + glow * 1.4), a: Math.min(1, 0.5 * tw + glow * 0.5), glow, tint: pt.tint };
        });

        for (const [a, b] of fig.edges) {
          const p1 = pts[a];
          const p2 = pts[b];
          if (!p1 || !p2) continue;
          const lift = Math.max(p1.glow, p2.glow);
          ctx!.strokeStyle = `rgba(170, 205, 255, ${0.2 + lift * 0.55})`;
          ctx!.lineWidth = 1 + lift * 1.1;
          ctx!.beginPath();
          ctx!.moveTo(p1.x, p1.y);
          ctx!.lineTo(p2.x, p2.y);
          ctx!.stroke();
        }

        for (const pt of pts) {
          const [cr, cg, cb] = STAR_COLORS[pt.tint];
          const bl = pt.r * 6 * (1 + pt.glow * 1.5);
          const g2 = ctx!.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, bl);
          g2.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${pt.a * 0.45})`);
          g2.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
          ctx!.fillStyle = g2;
          ctx!.beginPath();
          ctx!.arc(pt.x, pt.y, bl, 0, Math.PI * 2);
          ctx!.fill();

          ctx!.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${pt.a})`;
          ctx!.beginPath();
          ctx!.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2);
          ctx!.fill();
        }
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
  }, [plain]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="constellations pointer-events-none absolute inset-0 h-full w-full"
      style={{ zIndex: 1 }}
    />
  );
}
