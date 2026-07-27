type Point = { label: string; value: number };

/** Compact money, so thousands stay readable at axis-label size. */
function compactMoney(n: number): string {
  if (n >= 1_000_000) return `$${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `$${trim(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}
function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** Round the axis top up to a clean step for the magnitude in play. */
function niceCeil(max: number): number {
  if (max <= 0) return 1000;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = magnitude / 2;
  return Math.ceil(max / step) * step;
}

function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const t = 0.18;
    const c1x = p1.x + (p2.x - p0.x) * t;
    const c1y = p1.y + (p2.y - p0.y) * t;
    const c2x = p2.x - (p3.x - p1.x) * t;
    const c2y = p2.y - (p3.y - p1.y) * t;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
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
  const W = 640;
  const H = height;
  const padL = 52;
  const padR = 20;
  const padT = 28;
  const padB = 34;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const max = Math.max(...data.map((d) => d.value));
  const min = 0;
  const niceMax = niceCeil(max);

  const x = (i: number) => padL + (innerW * i) / (data.length - 1);
  const y = (v: number) => padT + innerH * (1 - (v - min) / (niceMax - min));

  const pts = data.map((d, i) => ({ x: x(i), y: y(d.value), ...d }));
  const line = smoothPath(pts);
  const area = `${line} L ${pts[pts.length - 1].x} ${padT + innerH} L ${pts[0].x} ${
    padT + innerH
  } Z`;

  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => (niceMax / ticks) * i);
  const last = pts[pts.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img">
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent-to)" stopOpacity="0.32" />
          <stop offset="1" stopColor="var(--accent-to)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lineStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--accent-from)" />
          <stop offset="1" stopColor="var(--accent-to)" />
        </linearGradient>
      </defs>

      {/* Grid + y labels */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line
            x1={padL}
            x2={W - padR}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--border)"
            strokeDasharray="2 5"
          />
          <text
            x={padL - 12}
            y={y(t) + 4}
            textAnchor="end"
            fontSize="11"
            fill="var(--text-faint)"
          >
            {format(t)}
          </text>
        </g>
      ))}

      <path d={area} fill="url(#areaFill)" />
      <path d={line} fill="none" stroke="url(#lineStroke)" strokeWidth="2.5" strokeLinecap="round" />

      {/* Point markers + value labels. Zero weeks are left unlabelled — a row
          of "$0" above an empty stretch is noise, and the axis already says it. */}
      {pts.map((p, i) => (
        <g key={i}>
          {p.value > 0 && (
            <text
              x={p.x}
              y={p.y - 12}
              textAnchor="middle"
              fontSize="11"
              fontWeight="600"
              fill="var(--text-muted)"
            >
              {format(p.value)}
            </text>
          )}
          <circle cx={p.x} cy={p.y} r="4" fill="var(--panel-solid)" stroke="var(--accent)" strokeWidth="2.5" />
          <text
            x={p.x}
            y={H - 10}
            textAnchor="middle"
            fontSize="11"
            fill="var(--text-faint)"
          >
            {p.label}
          </text>
        </g>
      ))}

      {/* Highlighted endpoint */}
      <circle cx={last.x} cy={last.y} r="6" fill="var(--accent)" />
      <circle cx={last.x} cy={last.y} r="11" fill="var(--accent)" opacity="0.18" />
    </svg>
  );
}
