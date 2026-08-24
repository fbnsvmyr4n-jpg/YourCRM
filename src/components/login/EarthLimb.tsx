/**
 * The curve of the Earth along the bottom of the frame.
 *
 * Replaces the mountain ridgeline: the reference is shot from orbit, and the
 * horizon is what fixes the viewpoint — without it the star field could be
 * anywhere.
 *
 * Built from stacked circles rather than an image so it stays crisp at any
 * size and costs nothing to load:
 *   • a wide atmospheric haze that bleeds upward into the sky
 *   • a hairline rim where the atmosphere catches the sun
 *   • the dark body of the planet
 *   • city lights, masked to a band just inside the edge so they follow the
 *     curve instead of floating on the disc
 *
 * The circle is far wider than the viewport, so only a shallow arc shows —
 * which is what makes it read as a planet rather than a dome.
 */
export function EarthLimb() {
  return (
    <div className="earth" aria-hidden>
      <div className="earth-halo" />
      <div className="earth-body">
        {/*
          The planet's surface, and the reason it is here.

          Without it the Earth is a black disc under a blue sky, which is the
          single detail that gives the whole scene away — the reference frames
          all show cloud and ocean catching the light. Both layers are lit by
          `--env-daylight`, so they appear as the terminator passes and are
          genuinely absent at night, when the only thing on the dark side is
          city light.

          Drawn from fractal noise rather than an image: it is a few hundred
          bytes, it stays crisp at any size, and `public/` holds no assets at
          all. The noise is static — nothing here animates, so it costs one
          rasterisation and nothing per frame.
        */}
        <div className="earth-ocean" />
        <div className="earth-clouds" />
        <div className="earth-rim" />
        <div className="earth-lights" />
      </div>
    </div>
  );
}
