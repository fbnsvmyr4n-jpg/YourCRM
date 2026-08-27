import { clamp01 } from "./curves";
import type { MoonSnapshot, SolarSnapshot } from "../solar/types";

/**
 * Where a body sits in the frame, seen from orbit.
 *
 * The canonical composition: the Earth's limb curves across the bottom, and the
 * sun and moon are **behind** it — so they rise over the edge, cross the sky
 * above it, and are occulted by the planet rather than sinking into a flat
 * horizon line.
 *
 * That curve is what makes this its own projection rather than a scaled
 * altitude. On a flat horizon, "altitude 0" is one screen row. Here it is an
 * arc: a body at the frame's edge sits *lower* than one at the centre, because
 * the planet's shoulder is further away there. Getting this wrong is not subtle
 * — the sun visibly floats above the limb at the edges, or sinks into it — and
 * it is why §12 insists the mapping lives in one calibrated module instead of
 * being estimated inside a component.
 *
 * Coordinates are normalised: x runs 0 (left) to 1 (right), y runs 0 (top) to 1
 * (bottom), matching how CSS will consume them.
 */

export type ScenePoint = {
  x: number;
  y: number;
  /**
   * How much of the body is showing above the limb, 0…1.
   *
   * A ramp rather than a flag, and for a physical reason: the sun's disc is
   * about half a degree across and takes two or three minutes to cross the
   * horizon, so it is genuinely half-set for a while. A boolean would pop it
   * out of existence in one frame — a hard cut at the single most-watched
   * moment of the whole cycle, which is exactly what §29 forbids.
   */
  visible: number;
  /**
   * How far below the horizon, 0…1, for a body that has set.
   *
   * Not merely a flag: the glow of a sun just under the edge is most of what
   * makes a sunset read as a sunset, and it needs to fade over the minutes
   * after the disc has gone rather than switching off with it.
   */
  belowHorizon: number;
};

/**
 * How much sky the frame shows, left to right, in degrees.
 *
 * Deliberately very wide. A realistic lens would be 60–90°, which would hold
 * the sun in frame for barely three hours of a twelve-hour day and leave the
 * composition empty for the rest — technically honest and useless as a login
 * screen. At 220° the sun enters near one edge around sunrise and leaves near
 * the other around sunset, so the whole arc is a thing you can watch.
 */
export const HORIZONTAL_FOV_DEG = 220;

/**
 * How much sky the frame shows from the limb upward, in degrees.
 *
 * Less than the horizontal span, because the interesting part of this scene is
 * the band just above the horizon. A sun at 60° would otherwise sit off the top
 * of the frame for most of a summer day.
 */
export const VERTICAL_FOV_DEG = 70;

/**
 * The limb's curvature.
 *
 * The horizon is an arc of a circle whose centre sits below the frame. A larger
 * radius is a flatter horizon — a lower orbit, or a longer lens. This value
 * puts the limb's lowest visible point at the frame edges roughly 8% of the
 * frame height below its centre, which is what the reference frames show.
 */
const LIMB_RADIUS = 3.2;

/** Where the limb's summit sits vertically, as a fraction of frame height. */
const LIMB_SUMMIT_Y = 0.86;

/**
 * Half the sun's apparent width, in degrees.
 *
 * The real figure: the sun and the moon both subtend about half a degree, a
 * coincidence that gives us total eclipses. It is what makes setting a gradual
 * event rather than an instant one.
 */
const DISC_RADIUS_DEG = 0.27;

/**
 * The horizon's height at a given horizontal position.
 *
 * The circle is centred at (0.5, LIMB_SUMMIT_Y + LIMB_RADIUS), so its topmost
 * point is the summit and it falls away toward both edges. Returned in the same
 * normalised units as everything else.
 */
export function limbY(x: number): number {
  const centreY = LIMB_SUMMIT_Y + LIMB_RADIUS;
  const dx = x - 0.5;
  // `max(0, ...)` guards the square root for any x far outside the frame, which
  // a body well off-screen legitimately produces. Without it this returns NaN
  // and the NaN travels all the way into a CSS property.
  const under = Math.max(0, LIMB_RADIUS * LIMB_RADIUS - dx * dx);
  return centreY - Math.sqrt(under);
}

/**
 * The bearing the camera looks along.
 *
 * The sun's own azimuth at solar noon — so the day's arc is centred in the
 * frame rather than happening somewhere behind the viewer. It differs by
 * hemisphere (due north from Cape Town, due south from London) and the camera
 * simply follows, which is the honest reading of "looking at the day side".
 *
 * Derived from the snapshot rather than configured, so it is right everywhere
 * without a table of locations to maintain.
 */
export function facingBearing(sun: SolarSnapshot): number {
  // At solar noon the sun is due north in the southern hemisphere and due south
  // in the northern. Its azimuth at that moment is exactly the bearing worth
  // pointing at, and it is stable for the whole day.
  return sun.solarNoonAzimuthDeg;
}

/**
 * The signed angle from `facing` to `bearing`, in [-180, 180].
 *
 * Wrapped, and this is the whole reason the function exists. Azimuth runs 0…360
 * and rolls over through north; subtracting two bearings naively produces a
 * 359° difference where the true one is 1°, and the sun leaps the full width of
 * the frame in a single tick. It is the classic discontinuity in any scene
 * driven by a compass, and it is guarded by a continuity test rather than by
 * hoping the roll-over happens at night.
 *
 * ## The one discontinuity that stays
 *
 * At exactly 180° from `facing` — directly BEHIND the camera — the result flips
 * between +180 and −180, and the projected x jumps from one side of the frame
 * to the other. That is not a defect to be smoothed away: it is what "behind
 * you" means to a single camera, and any damping applied to it would be a lie
 * about where the body actually is.
 *
 * It is invisible, and that is a consequence of the field of view rather than
 * luck. The flip happens at ±180°, which the 220° frame places at
 * x = 0.5 ± 0.818 — off both edges, since the frame is x ∈ [0, 1]. Any field of
 * view narrower than 360° puts its own antipode off-screen for the same reason,
 * so the jump can never be seen however far the body has to travel.
 *
 * That mattered more than it first appeared. At mid-latitudes the sun crosses
 * the antipode around local midnight, sixty degrees underground, and it would be
 * tempting to call the case handled. Inside the Arctic Circle in June it crosses
 * while still ABOVE the horizon, in full view — the midnight sun goes right
 * round the compass. The geometry is what makes that safe; an altitude threshold
 * would not have been.
 */
export function bearingDelta(bearing: number, facing: number): number {
  return ((((bearing - facing) % 360) + 540) % 360) - 180;
}

/**
 * Put a body in the frame.
 *
 * Horizontal position comes from azimuth, vertical from altitude measured
 * *above the limb at that horizontal position* — which is what respects the
 * curve.
 */
export function project(
  altitudeDeg: number,
  azimuthDeg: number,
  facingDeg: number
): ScenePoint {
  if (!Number.isFinite(altitudeDeg) || !Number.isFinite(azimuthDeg)) {
    return { x: 0.5, y: limbY(0.5), visible: 0, belowHorizon: 1 };
  }

  const delta = bearingDelta(azimuthDeg, facingDeg);
  const x = 0.5 + delta / HORIZONTAL_FOV_DEG;

  const horizon = limbY(x);
  // Altitude scaled against the vertical field of view, then measured upward
  // from the limb at this x rather than from a fixed row.
  const rise = (altitudeDeg / VERTICAL_FOV_DEG) * horizon;
  const y = horizon - rise;

  return {
    x,
    y,
    // Ramped across the disc's own angular width, centred on the horizon: fully
    // up at +DISC, fully gone at −DISC.
    visible: clamp01((altitudeDeg + DISC_RADIUS_DEG) / (2 * DISC_RADIUS_DEG)),
    // Full darkness by 12° below, which is roughly where the last of a sunset's
    // glow actually goes.
    belowHorizon: altitudeDeg >= 0 ? 0 : Math.min(1, -altitudeDeg / 12),
  };
}

/** The sun and the moon, in one call, sharing one camera. */
export function projectBodies(sun: SolarSnapshot, moon: MoonSnapshot) {
  const facing = facingBearing(sun);
  return {
    facing,
    sun: project(sun.altitudeDeg, sun.azimuthDeg, facing),
    /**
     * The same projection for the moon, which is what makes the pair behave.
     * A full moon rises as the sun sets and sits opposite it in the sky — so it
     * appears at the far side of the frame without anything having to arrange
     * that, because it is simply true.
     */
    moon: project(moon.altitudeDeg, moon.azimuthDeg, facing),
  };
}

/**
 * Where the sun and moon must be POINTED for the shader to draw them in frame.
 *
 * ## The bug this exists to fix
 *
 * Moving the discs out of CSS and into the fragment shader gave them the
 * shader's real camera — 58° vertical and about 52° horizontal. That is
 * physically correct and it means **the sun is on screen 0.0% of the day**.
 * Measured over a full day at Cape Town: the sun is within the frame's bearing
 * 13.9% of the time and within its altitude 1.4%, and never both at once. The
 * CSS scene had been hiding this behind a deliberately wide 220°×70° projection
 * that folds the whole sky into the frame.
 *
 * So the discs get an artistic direction and the light keeps the physical one.
 * `uSunDir` still lights the planet from the true solar vector; only where the
 * disc is DRAWN comes from here.
 *
 * ## Why this stays honest
 *
 * Two properties survive the remap, and they are the two that carry the moment:
 *
 * 1. **The limb sits at the same angle in every direction.** The planet is a
 *    sphere seen from directly above the observer, so its edge is at −57.5° of
 *    local altitude whichever way the camera faces. Compressing AZIMUTH
 *    therefore cannot change when a body crosses it.
 *
 * 2. **Occlusion and reddening are computed from the pixel, not from here.**
 *    Whether a fragment is in front of the planet, and how much air its ray
 *    crossed, are properties of that ray. The disc is placed artistically and
 *    then rendered by the same physics as everything around it.
 *
 * Altitude is mapped so that **real altitude 0° lands exactly on the limb** —
 * the composition's whole premise is that sunset happens at the planet's edge,
 * which is what the CSS scene did with `rise = altitude / 70 * horizon`.
 */

/** Local altitude of the planet's edge, seen from the scene's camera height. */
export const LIMB_ALTITUDE_DEG = -57.5;

/** Local altitude of the top of the shader's frame: pitch + half the FOV. */
const FRAME_TOP_DEG = -12;

/**
 * How far either side of centre the arc is allowed to reach.
 *
 * Read off the reference sketch, which runs x 0.09 to 0.97 — a half-width of
 * 0.44 about a centre at 0.53. Ours is symmetric about 0.5, so 0.44 it is.
 */
const ARC_HALF_WIDTH = 0.44;

/**
 * How quickly the arc reaches that half-width as the sun swings away from the
 * camera's bearing. Larger keeps the sun nearer the middle for longer.
 */
const ARC_AZIMUTH_SOFT_DEG = 62;

/**
 * How quickly altitude lifts the body off the limb.
 *
 * Solves `1 − e^(−56/s) = 34.8 / span`, which puts the equinox apex on the
 * reference's y ≈ 0.20. See the note in `aimBody`.
 */
const ALT_SCALE_DEG = 38.7;

export type BodyAim = {
  /** Unit vector in the observer's local frame: x east, y north, z up. */
  direction: [number, number, number];
  /**
   * How close the body is to the limb, 0 (clear of it) to 1 (touching).
   *
   * Drives the refraction flattening. A real sun seen at the limb from orbit is
   * visibly squashed — its light is passing tangentially through the atmosphere
   * and being bent — and it is the single most recognisable feature of the
   * moment. Without it a disc slides behind the edge looking like a coin behind
   * a card.
   */
  limbProximity: number;
};

export type AimCamera = {
  /** Vertical field of view, radians. */
  fovRad: number;
  /** Downward tilt, radians (negative). */
  pitchRad: number;
  /** Compass bearing the camera faces, degrees. */
  facingDeg: number;
  /** Drawing buffer width / height. */
  aspect: number;
};

/**
 * Project a local direction to normalised screen coordinates.
 *
 * The exact inverse of the ray the fragment shader builds, so "where will this
 * appear" is answered by the same arithmetic that decides where it is drawn.
 */
function screenOf(direction: [number, number, number], camera: AimCamera) {
  const cy = Math.cos((camera.facingDeg * Math.PI) / 180);
  const sy = Math.sin((camera.facingDeg * Math.PI) / 180);
  const lx = direction[0] * cy - direction[1] * sy;
  const ly = direction[0] * sy + direction[1] * cy;
  const lz = direction[2];

  const cp = Math.cos(camera.pitchRad);
  const sp = Math.sin(camera.pitchRad);
  const rx = lx;
  const ry = ly * cp + lz * sp;
  const rz = -ly * sp + lz * cp;
  if (ry <= 0) return null;

  const t = Math.tan(camera.fovRad / 2);
  return {
    x: ((rx / ry / t / camera.aspect) + 1) / 2,
    y: 1 - ((rz / ry / t) + 1) / 2,
  };
}

function directionAt(altitudeDeg: number, azimuthDeg: number): [number, number, number] {
  const a = (altitudeDeg * Math.PI) / 180;
  const z = (azimuthDeg * Math.PI) / 180;
  const c = Math.cos(a);
  return [c * Math.sin(z), c * Math.cos(z), Math.sin(a)];
}

/**
 * Where the sun and moon must be POINTED for the shader to draw them in frame.
 *
 * ## The bug this exists to fix
 *
 * Moving the discs out of CSS and into the fragment shader gave them the
 * shader's real camera — 58° vertical, about 52° horizontal. That is physically
 * correct and it means **the sun is on screen 0.0% of the day**: measured over a
 * full day at Cape Town it is within the frame's bearing 13.9% of the time and
 * within its altitude 1.4%, and never both at once. The CSS scene had been
 * hiding that behind a deliberately wide 220°×70° projection folding the whole
 * sky into the frame.
 *
 * So the discs get an artistic direction and the light keeps the physical one.
 * `uSunDir` still lights the planet from the true solar vector; only where the
 * disc is DRAWN comes from here. Two properties survive the remap, and they are
 * the two that carry the moment:
 *
 * 1. **The limb sits at the same altitude in every direction.** The planet is a
 *    sphere seen from directly above the observer, so its edge is at −57.5° of
 *    local altitude whichever way the camera faces. Moving a body in AZIMUTH
 *    therefore cannot change when it crosses the limb.
 * 2. **Occlusion and reddening are computed from the pixel, not from here.**
 *
 * ## Why the azimuth is SOLVED rather than scaled
 *
 * The first two attempts scaled azimuth by a constant, and neither could be
 * made to hold. A body's screen x depends on its altitude as well as its
 * bearing, so bounding the angle does not bound the position: at Cape Town's
 * midsummer, where azimuth swings ±115° instead of the equinox's ±89°, every
 * constant that framed the equinox correctly threw the sun off the side of the
 * screen for up to ten hours.
 *
 * The requirement lives in screen space, so the aim is specified there: pick
 * the x the arc should pass through — a `tanh` that cannot exceed
 * ARC_HALF_WIDTH — and then solve for the azimuth that projects to it. Screen x
 * is monotonic in azimuth, so a bisection converges in a few steps, and it runs
 * once per body per frame rather than per pixel.
 *
 * The result is bounded by construction, in every season and at every latitude,
 * with no constant left to be wrong.
 */
export function aimBody(
  altitudeDeg: number,
  azimuthDeg: number,
  camera: AimCamera
): BodyAim {
  if (!Number.isFinite(altitudeDeg) || !Number.isFinite(azimuthDeg)) {
    return { direction: [0, 1, 0], limbProximity: 0 };
  }

  /*
     Altitude, approaching the top of the frame rather than marching past it.

     A straight `altitude / 70 × span` is the obvious map and cannot satisfy
     both requirements at once. Placing the apex where the reference puts it
     (y ≈ 0.20 at the equinox's 56°) needs 34.8° of rise; keeping the sun inside
     the frame at Cape Town's midsummer 79.5° allows at most 28.3°. Any linear
     map either sits the arc too low or throws the sun off the top for an hour
     around midsummer noon.

     An exponential approach satisfies both: it reaches FRAME_TOP_DEG only in
     the limit, so no altitude can overshoot the frame, while still rising fast
     enough near the horizon to put the equinox apex on the reference line.

     Below the horizon it continues linearly at the curve's own slope at zero,
     so value and gradient are both continuous — a body that has just set is
     just BEHIND the edge, and does not visibly change pace as it crosses.
  */
  const span = FRAME_TOP_DEG - LIMB_ALTITUDE_DEG;
  const rise =
    altitudeDeg >= 0
      ? span * (1 - Math.exp(-altitudeDeg / ALT_SCALE_DEG))
      : (span / ALT_SCALE_DEG) * altitudeDeg;
  const displayAlt = LIMB_ALTITUDE_DEG + rise;

  const delta = bearingDelta(azimuthDeg, camera.facingDeg);
  const targetX = 0.5 + ARC_HALF_WIDTH * Math.tanh(delta / ARC_AZIMUTH_SOFT_DEG);

  /* Bisection on azimuth. Screen x rises monotonically with bearing across the
     half-turn either side of the camera, so this is well behaved; 40 steps take
     it far below one pixel. A direction whose ray falls behind the camera
     projects to null, which is treated as "further out than any valid answer"
     so the search walks back toward the centre instead of stalling. */
  let low = camera.facingDeg - 89;
  let high = camera.facingDeg + 89;
  let azimuth = camera.facingDeg + delta;
  for (let i = 0; i < 40; i++) {
    azimuth = (low + high) / 2;
    const point = screenOf(directionAt(displayAlt, azimuth), camera);
    const x = point ? point.x : delta > 0 ? Infinity : -Infinity;
    if (x < targetX) low = azimuth;
    else high = azimuth;
  }

  return {
    direction: directionAt(displayAlt, azimuth),
    /*
       Ramped over 2.5° of real altitude, not 6°.

       Six degrees is roughly eighty minutes either side of the horizon, and the
       sun spent all of it visibly squashed — a permanent-looking distortion
       rather than a moment. Refraction only bends the image appreciably in the
       last degree or two before the horizon, when the light is raking through
       the deepest slant of air. Narrowing it makes the flattening read as
       something happening rather than as the shape the sun simply has.
    */
    limbProximity: clamp01(1 - Math.abs(altitudeDeg) / 2.5),
  };
}

/* ---------------- Where the camera actually stands ---------------- */

/**
 * How far the camera sits behind the observer, in degrees of arc.
 *
 * The camera used to sit directly above the observer, and that put the
 * observer's own location off the bottom of the screen. The geometry, traced
 * against the shader's real 58° frame at 5,500km with a -41° pitch:
 *
 *   frame centre       sky — no ground at all
 *   limb               53.0° of arc away  (5,880km)
 *   bottom of frame    19.6° of arc away  (2,174km)
 *
 * So the nearest ground the camera could see was already 2,174km away, and the
 * observer was 2,174km below the frame. From Cape Town, facing the solar-noon
 * bearing of due north, the visible band began somewhere over Angola — which is
 * exactly the "shows Southern Africa but cuts off Cape Town" that was reported.
 * There was no zoom or accuracy problem: the place was never on screen.
 *
 * 28° puts it at about 78% of the way down the frame. The earth occupies the
 * band from ndcY -0.54 (the limb) to -1.0 (the bottom edge), so this lands the
 * observer near the middle of the planet rather than balanced on its edge.
 */
export const CAMERA_ARC_DEG = 28;

/**
 * The ground point the camera stands over, given where the observer is and
 * which way the composition faces.
 *
 * Backwards along the facing bearing, so the observer ends up AHEAD of the
 * camera and therefore inside the frame. Standard destination-point formula on
 * a sphere; `arcDeg` is angular, so it needs no radius and is exact for any.
 */
export function cameraAnchor(
  where: { latitude: number; longitude: number },
  facingDeg: number,
  arcDeg: number = CAMERA_ARC_DEG
): { latitude: number; longitude: number } {
  const rad = Math.PI / 180;
  const lat = where.latitude * rad;
  const lon = where.longitude * rad;
  // Behind the observer, not in front of them.
  const brg = (facingDeg + 180) * rad;
  const d = arcDeg * rad;

  const sinLat = Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(brg);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat)));
  const lon2 =
    lon +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(lat),
      Math.cos(d) - Math.sin(lat) * sinLat
    );

  return {
    latitude: lat2 / rad,
    // Back into (-180, 180]; a camera near the date line otherwise reads as
    // being most of a world away from where it is.
    longitude: (((lon2 / rad + 540) % 360) - 180),
  };
}

/** East/north/up at a point, as columns of a matrix into earth-fixed coordinates. */
function enuAxes(where: { latitude: number; longitude: number }) {
  const rad = Math.PI / 180;
  const la = where.latitude * rad;
  const lo = where.longitude * rad;
  const sLa = Math.sin(la), cLa = Math.cos(la);
  const sLo = Math.sin(lo), cLo = Math.cos(lo);
  return {
    east: [-sLo, cLo, 0] as const,
    north: [-sLa * cLo, -sLa * sLo, cLa] as const,
    up: [cLa * cLo, cLa * sLo, sLa] as const,
  };
}

/**
 * The same direction, written in a different place's local frame.
 *
 * The shader lights the planet with `uSunDir`, which is a vector in the
 * observer's east/north/up — so moving the camera without re-expressing it
 * would light the ground from a direction 28° of arc wrong and slide the
 * terminator across the map. At sunrise the terminator is the most visible
 * thing in the frame, so that would have been an obvious break traded for a
 * fixed one.
 *
 * A direction is a fact about the world, not about the frame it is written in:
 * lift it into earth-fixed coordinates through one frame's axes, and read it
 * back down through the other's.
 */
export function reframeDirection(
  dir: ArrayLike<number>,
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number }
): [number, number, number] {
  const a = enuAxes(from);
  const b = enuAxes(to);

  const ecef = [0, 1, 2].map(
    (i) => dir[0] * a.east[i] + dir[1] * a.north[i] + dir[2] * a.up[i]
  );

  const dot = (v: readonly number[]) => ecef[0] * v[0] + ecef[1] * v[1] + ecef[2] * v[2];
  return [dot(b.east), dot(b.north), dot(b.up)];
}
