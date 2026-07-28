/**
 * The static backdrop: sky, horizon glow, haze and four mountain ranges.
 *
 * Replaces three flat polygons that shared one flat fill. The realism here
 * comes almost entirely from **atmospheric perspective** — distant ranges are
 * lighter, bluer and lower-contrast because there is more air between you and
 * them, and each range is separated from the next by a band of haze pooling in
 * the valley. Get that right and crude silhouettes read as miles away; get it
 * wrong and detailed ones still look like cardboard cutouts.
 *
 * Ridgelines use many short, irregular segments rather than long straight runs
 * between peaks, since real skylines almost never present a clean diagonal.
 *
 * Server-rendered — there is nothing interactive here, so it costs no JS.
 */
export function NightScene() {
  return (
    <svg
      className="absolute bottom-0 left-0 right-0"
      style={{ height: "62vh" }}
      viewBox="0 0 1440 560"
      preserveAspectRatio="xMidYMax slice"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        {/* Each range is lit slightly along its ridge by the sky behind it,
            and falls to near-black at its base. */}
        <linearGradient id="ridge1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d2a44" />
          <stop offset="1" stopColor="#141d31" />
        </linearGradient>
        <linearGradient id="ridge2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#16203a" />
          <stop offset="1" stopColor="#0e1526" />
        </linearGradient>
        <linearGradient id="ridge3" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0e1524" />
          <stop offset="1" stopColor="#080d18" />
        </linearGradient>
        <linearGradient id="ridge4" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#070b14" />
          <stop offset="1" stopColor="#03050b" />
        </linearGradient>

        {/* Haze pooling in each valley, densest at the base of the range in
            front and fading upward. This is what separates the layers. */}
        {/* Both ends must reach fully transparent. An earlier version finished
            at 0.02 alpha, which drew a visible horizontal seam across the
            scene wherever a haze band ended — the rect edge showing through. */}
        <linearGradient id="haze" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(120,160,220,0)" />
          <stop offset="0.5" stopColor="rgba(120,160,220,0.11)" />
          <stop offset="1" stopColor="rgba(120,160,220,0)" />
        </linearGradient>

        {/* A cool wash sitting just above the skyline — airglow. */}
        <linearGradient id="horizon" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(70,120,200,0)" />
          <stop offset="1" stopColor="rgba(80,140,215,0.13)" />
        </linearGradient>
      </defs>

      {/* Airglow above the peaks */}
      <rect x="0" y="40" width="1440" height="210" fill="url(#horizon)" />

      {/* Ridgelines below are deliberately irregular: peaks of very different
          heights and widths, asymmetric slopes (one flank steeper than the
          other), and long quiet stretches between summits. An earlier version
          spaced similar-sized peaks evenly and the result read as a mechanical
          sawtooth — evenness is the thing that destroys the illusion. */}

      {/* ---- Range 1 — furthest. Palest, lowest contrast, one dominant massif. ---- */}
      <path
        fill="url(#ridge1)"
        opacity="0.5"
        d="M0,560 L0,268 L74,258 L138,262 L196,236 L246,244 L318,168 L352,196 L392,182 L436,214 L492,232 L548,222 L604,238 L662,196 L698,214 L742,206 L806,230 L868,240 L926,214 L968,228 L1024,150 L1058,182 L1098,170 L1146,206 L1208,228 L1268,216 L1330,234 L1388,222 L1440,240 L1440,560 Z"
      />
      <rect x="0" y="250" width="1440" height="130" fill="url(#haze)" />

      {/* ---- Range 2 — a broad shoulder left, a sharper pair right. ---- */}
      <path
        fill="url(#ridge2)"
        opacity="0.78"
        d="M0,560 L0,352 L68,344 L128,318 L182,330 L244,296 L296,314 L358,326 L420,300 L468,312 L532,268 L570,296 L618,286 L676,318 L740,332 L802,306 L858,320 L918,282 L962,308 L1012,298 L1074,326 L1136,338 L1196,312 L1252,326 L1316,300 L1370,318 L1440,330 L1440,560 Z"
      />
      <rect x="0" y="322" width="1440" height="140" fill="url(#haze)" />

      {/* ---- Range 3 — the dramatic one; tallest single peak sits off-centre. ---- */}
      <path
        fill="url(#ridge3)"
        d="M0,560 L0,432 L82,420 L156,428 L228,398 L286,414 L352,386 L414,404 L470,352 L512,382 L566,370 L638,406 L706,418 L772,392 L836,408 L896,378 L950,398 L1012,388 L1084,416 L1152,428 L1220,402 L1284,418 L1346,396 L1402,412 L1440,404 L1440,560 Z"
      />
      <rect x="0" y="400" width="1440" height="130" fill="url(#haze)" opacity="0.65" />

      {/* ---- Range 4 — nearest. Near-black, few features, anchors the frame. ---- */}
      <path
        fill="url(#ridge4)"
        d="M0,560 L0,492 L96,478 L188,488 L272,462 L352,476 L438,466 L522,484 L614,470 L700,486 L786,474 L872,490 L958,472 L1046,488 L1132,476 L1218,492 L1304,478 L1378,490 L1440,482 L1440,560 Z"
      />
    </svg>
  );
}
