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
// Pulled right down and darkened. The reference is pure cosmos — the landscape
// is here only to anchor the bottom of the frame and give the sky something to
// end against. At 62vh it was the subject and it fought the nebula.
export function NightScene() {
  return (
    <svg
      className="absolute bottom-0 left-0 right-0"
      /* `width: 100%` is load-bearing. An <svg> is a replaced element: given an
         explicit height and auto width it derives its width from the viewBox
         aspect ratio and ignores `right: 0`, so the scene stops partway across
         and leaves a hard vertical edge. This was latent at the previous 62vh,
         where the derived width happened to land within a few pixels of a
         1440-wide viewport — dropping to 34vh is what exposed it. */
      style={{
        width: "100%",
        height: "34vh",
        opacity: 0.62,
        /* `slice` crops the viewBox, and the content at the crop line has real
           brightness, so the top of the element lands as a hard horizontal
           edge across the sky. Fading the first fifth blends it into the
           starfield instead. */
        maskImage: "linear-gradient(to bottom, transparent 0%, #000 20%)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, #000 20%)",
      }}
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
            scene wherever a haze band ended — the rect edge showing through.

            Substantially denser than before: in the reference photographs the
            valley mist is nearly white and reads as a distinct layer sitting
            between ridges, not as a whisper. */}
        <linearGradient id="haze" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(150,180,230,0)" />
          <stop offset="0.42" stopColor="rgba(168,196,238,0.2)" />
          <stop offset="0.62" stopColor="rgba(158,188,234,0.16)" />
          <stop offset="1" stopColor="rgba(140,175,225,0)" />
        </linearGradient>

        {/* Warm airglow low at the skyline grading to cool blue above — the
            amber-under-blue split that gives the reference shots their depth.
            The scene was cool all the way down, which read flat beside them. */}
        <linearGradient id="horizon" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(70,120,200,0)" />
          <stop offset="0.45" stopColor="rgba(86,132,205,0.1)" />
          <stop offset="0.78" stopColor="rgba(168,132,150,0.13)" />
          <stop offset="1" stopColor="rgba(226,158,110,0.16)" />
        </linearGradient>
      </defs>

      {/* Airglow above the peaks */}
      <rect x="0" y="20" width="1440" height="290" fill="url(#horizon)" />

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
