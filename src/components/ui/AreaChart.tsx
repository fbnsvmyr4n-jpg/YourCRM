"use client";

import { useEffect, useRef, useState } from "react";
import { placeValueLabels } from "@/lib/place-labels";

type Point = { label: string; value: number };

/** Used until the container has been measured, so a chart always exists. */
const FALLBACK_WIDTH = 560;

/** Compact money, so thousands stay readable at axis-label size. */
function compactMoney(n: number): string {
  if (n >= 1_000_000) return `$${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `$${trim(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}
function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/**
 * A scale whose gridlines land on numbers a person would choose.
 *
 * The old version rounded only the *top* of the axis and then divided it into
 * equal parts, which produced ticks like $13.8K / $27.5K / $41.3K — arithmetically
 * correct and unreadable. This picks a round **step** first (1, 2, 2.5 or 5 at
 * the right magnitude) and lets the top follow, giving $0 / $20K / $40K / $60K.
 */
function niceScale(max: number, targetTicks: number): { niceMax: number; step: number } {
  if (!Number.isFinite(max) || max <= 0) return { niceMax: 1000, step: 250 };

  const raw = max / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const step =
    (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10) *
    magnitude;

  return { niceMax: Math.ceil(max / step) * step, step };
}

/**
 * Width of a label, without putting it in the document first.
 *
 * A single characters-times-a-constant estimate is wrong here, because these
 * labels mix two very different alphabets: money and dates. Charging each class
 * its own rate tracks the truth closely enough to decide whether two labels
 * collide.
 *
 * The rates are MEASURED, not guessed. An earlier set was, and it charged
 * digits 0.6 and capitals 0.62 — against Geist at weight 700 a digit is 0.69
 * and a "K" is 0.69, so every money label came out about 7% narrow. That is the
 * dangerous direction: the placement logic thought it had left a 10px gap
 * between two figures and had actually left 6.3px. Taken from
 * `canvas.measureText` against the real font, and rounded UP where they were
 * ambiguous, so the error now leans wide — which for a collision test is the
 * side that costs nothing but a little extra air.
 *
 * These are bold advances. The axis labels are lighter and therefore narrower
 * still, so they are over-measured slightly, which only makes the x-axis a
 * fraction more willing to drop a date rather than crowd one.
 */
function textWidth(s: string, fontSize: number): number {
  let w = 0;
  for (const ch of s) {
    if (ch === " ") w += 0.23;
    // "1" really is half the width of every other digit in this face.
    else if (ch === "1") w += 0.46;
    else if (ch >= "0" && ch <= "9") w += 0.7;
    else if (ch === "$" || ch === "%") w += 0.7;
    else if (ch === "." || ch === ",") w += 0.24;
    // "M" is the outlier that "$1.25M" depends on; the rest of the capitals
    // used here (A, J, K, S) sit between 0.63 and 0.73.
    else if (ch === "M" || ch === "W") w += 0.92;
    else if (ch >= "A" && ch <= "Z") w += 0.73;
    else if ("ilt".includes(ch)) w += 0.33;
    else w += 0.62;
  }
  return w * fontSize;
}

/**
 * Which x labels to draw.
 *
 * Every point used to get one, so on a narrow card six dates ran together into
 * "7 Jul14 Ju21 Ju28 Ju4 Aug1 Aug". Labels are dropped by a stride computed
 * from the space each one actually has, counting back from the newest point so
 * the most recent date — the one being read — is always kept.
 */
function visibleLabels(labels: string[], spacing: number, fontSize: number): Set<number> {
  const n = labels.length;
  const keep = new Set<number>();
  if (n === 0) return keep;

  const widest = Math.max(...labels.map((l) => textWidth(l, fontSize)));
  const needed = widest + 10; // 10px of air, so neighbours never merely touch
  const stride = Math.max(1, Math.ceil(needed / Math.max(spacing, 1)));

  for (let i = n - 1; i >= 0; i -= stride) keep.add(i);

  // The start of the range is worth keeping, but not at the cost of a collision
  // with whatever the stride left next to it.
  const nearest = [...keep].filter((i) => i !== 0).sort((a, b) => a - b)[0];
  if (nearest !== undefined && nearest * spacing < needed && nearest !== n - 1) keep.delete(nearest);
  if (n === 1 || (n - 1) * spacing >= needed) keep.add(0);

  return keep;
}

/**
 * Monotone cubic interpolation (Fritsch–Carlson).
 *
 * The previous curve was a Catmull-Rom spline with a fixed tension, which
 * **overshoots**: with a $22.5K week sitting next to a run of $0 weeks, the
 * control points dragged the line ~15px *below* the zero gridline — the chart
 * drew negative revenue that never happened, and the area fill spilled under
 * the axis with it.
 *
 * A monotone spline is constrained so each segment stays within the values at
 * its two endpoints. A flat run of zeros stays flat, a rise cannot dip first,
 * and the curve can never leave the data's own range — so this is a guarantee
 * rather than a tuned constant that happens to look right on today's numbers.
 */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;

  const n = pts.length;

  // Secant slope of each segment.
  const dx: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    delta[i] = dx[i] === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx[i];
  }

  // Initial tangents: average of the neighbouring secants.
  const m: number[] = new Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (delta[i - 1] + delta[i]) / 2;

  // The constraint that removes overshoot: where a segment is flat, both of its
  // tangents are zeroed; elsewhere tangents are clamped to the Fritsch–Carlson
  // circle of radius 3.
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * delta[i];
      m[i + 1] = t * b * delta[i];
    }
  }

  // Hermite tangents → cubic Bézier control points.
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = pts[i].x + dx[i] / 3;
    const c1y = pts[i].y + (m[i] * dx[i]) / 3;
    const c2x = pts[i + 1].x - dx[i] / 3;
    const c2y = pts[i + 1].y - (m[i + 1] * dx[i]) / 3;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${pts[i + 1].x} ${pts[i + 1].y}`;
  }
  return d;
}

/**
 * Measure the container so the chart can be drawn at 1:1.
 *
 * This is the whole reason the labels were unreadable. The chart used to be
 * authored in a fixed 640-unit viewBox and then scaled to fit whatever width it
 * landed in — about 327px on this page. SVG scales *uniformly*, so every
 * `font-size="11"` painted at 11 × 0.51 ≈ **5.6px**, and the drawing filled only
 * half the height it had reserved, leaving ~98px blank above it.
 *
 * Drawing into a viewBox that matches the real pixel width makes one unit one
 * pixel: 12 means 12, and the height is used exactly.
 */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Setting state from the observer callback is an event, not an effect body.
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));

    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

export function AreaChart({
  data,
  height = 220,
  format = compactMoney,
  ticks = 4,
}: {
  data: Point[];
  height?: number;
  format?: (n: number) => string;
  ticks?: number;
}) {
  const [ref, measured] = useWidth();

  /**
   * Never render nothing.
   *
   * Waiting for the measurement before drawing anything means the chart is
   * blank during SSR, and stays blank for good if the observer is ever stale —
   * which is a worse failure than the small text this replaced. So it draws at
   * a sensible width immediately and snaps to exact once measured: `width` is
   * always 100%, so when the viewBox matches the real width the scale is
   * precisely 1, and before that it merely scales like the old chart did.
   */
  const W = measured || FALLBACK_WIDTH;
  const H = height;

  return (
    <div ref={ref} style={{ height: H }} className="w-full">
      {data.length > 1 && <Plot data={data} W={W} H={H} format={format} ticks={ticks} />}
    </div>
  );
}

const AXIS_FONT = 12;
/** The bold figures on the peak and the newest point. */
const VALUE_FONT = 13;

function Plot({
  data,
  W,
  H,
  format,
  ticks,
}: {
  data: Point[];
  W: number;
  H: number;
  format: (n: number) => string;
  ticks: number;
}) {
  const max = Math.max(...data.map((d) => d.value));
  const { niceMax, step } = niceScale(max, ticks);

  const yTicks: number[] = [];
  for (let v = 0; v <= niceMax + 1e-6; v += step) yTicks.push(v);

  // The gutter is sized from the widest tick this chart will actually print.
  // A fixed 56px happened to fit "$100K" and would have clipped "$1.25M".
  const widestY = Math.max(...yTicks.map((t) => textWidth(format(t), AXIS_FONT)));
  const padL = Math.max(44, Math.ceil(widestY) + 14);
  const padR = 22;
  const padT = 30;
  const padB = 34;

  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const x = (i: number) => padL + (innerW * i) / (data.length - 1);
  const y = (v: number) => padT + innerH * (1 - v / niceMax);

  const pts = data.map((d, i) => ({ x: x(i), y: y(d.value), ...d }));
  const line = smoothPath(pts);
  const area = `${line} L ${pts[pts.length - 1].x} ${padT + innerH} L ${pts[0].x} ${padT + innerH} Z`;

  const last = pts[pts.length - 1];

  const showLabel = visibleLabels(
    data.map((d) => d.label),
    innerW / (data.length - 1),
    AXIS_FONT
  );

  // Only the peak and the latest point carry a value label. Labelling every
  // point crowds a narrow chart, and those two are what the reader is after.
  const peakIdx = pts.reduce((best, p, i) => (p.value > pts[best].value ? i : best), 0);
  const labelled = new Set([peakIdx, pts.length - 1].filter((i) => pts[i].value > 0));

  // x labels are centred, so the first and last would otherwise overhang.
  //
  // Clamp the label's *edges*, not its anchor. These are `textAnchor="middle"`,
  // so half the string sits either side of x — clamping the anchor to `W - 4`
  // still let half the text past the edge, which measured as 1px clipped off
  // "$84.6K" and grows with the number ("$1.25M" would lose noticeably more).
  // If a label is wider than the chart there is no non-overhanging position, so
  // it centres rather than inverting the clamp.
  const clampX = (v: number, text: string, fontSize: number) => {
    const half = textWidth(text, fontSize) / 2;
    const lo = 4 + half;
    const hi = W - 4 - half;
    return hi < lo ? W / 2 : Math.min(hi, Math.max(lo, v));
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Revenue over the last six weeks">
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent-to)" stopOpacity="0.30" />
          <stop offset="1" stopColor="var(--accent-to)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lineStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--accent-from)" />
          <stop offset="1" stopColor="var(--accent-to)" />
        </linearGradient>
      </defs>

      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray="2 5" />
          <text x={padL - 10} y={y(t) + 4} textAnchor="end" fontSize={AXIS_FONT} fill="var(--text-muted)">
            {format(t)}
          </text>
        </g>
      ))}

      <path d={area} fill="url(#areaFill)" />
      <path d={line} fill="none" stroke="url(#lineStroke)" strokeWidth="2.5" strokeLinecap="round" />

      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r="4" fill="var(--panel-solid)" stroke="var(--accent)" strokeWidth="2.5" />
          {showLabel.has(i) && (
            <text x={clampX(p.x, p.label, AXIS_FONT)} y={H - 10} textAnchor="middle" fontSize={AXIS_FONT} fill="var(--text-muted)">
              {p.label}
            </text>
          )}
        </g>
      ))}

      {/*
          Laid out against each other, not just against the edges.
          Each of these used to be clamped only to the chart's edges, so nothing
          stopped the peak's figure from running into the newest one when the
          two points are neighbours. At 393px with a $364.4K peak beside a $30K
          latest week they overlapped by 6.6px — the narrower the screen, the
          more often it happens, because the gap between points shrinks while
          the text does not.
      */}
      {placeValueLabels(
        [...labelled].map((i) => ({
          i,
          x: pts[i].x,
          width: textWidth(format(pts[i].value), VALUE_FONT),
        })),
        // Left is the plot edge — beyond it is the gutter holding the tick
        // figures. Right is the chart edge, because that padding is empty.
        { left: padL, right: W - 4 }
      ).map(({ i, x }) => {
        const p = pts[i];
        return (
          <text
            key={`v${i}`}
            x={x}
            /* Clear of the marker beneath it. The newest point wears an 11px
               halo, so the old 14px lift left three pixels between the text and
               the glow — close enough to read as a collision even though the
               boxes did not touch. */
            y={Math.max(padT - 8, p.y - 20)}
            textAnchor="middle"
            fontSize={VALUE_FONT}
            fontWeight="700"
            fill="var(--text)"
          >
            {format(p.value)}
          </text>
        );
      })}

      <circle cx={last.x} cy={last.y} r="6" fill="var(--accent)" />
      <circle cx={last.x} cy={last.y} r="11" fill="var(--accent)" opacity="0.18" />
    </svg>
  );
}
