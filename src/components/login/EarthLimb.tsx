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
        <div className="earth-rim" />
        <div className="earth-lights" />
      </div>
    </div>
  );
}
