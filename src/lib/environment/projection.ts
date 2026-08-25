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
   * a card, which is what "a sun moving behind a 2D object" describes.
   */
  limbProximity: number;
};

export function aimBody(
  altitudeDeg: number,
  azimuthDeg: number,
  facingDeg: number,
  horizontalFovDeg: number
): BodyAim {
  if (!Number.isFinite(altitudeDeg) || !Number.isFinite(azimuthDeg)) {
    return { direction: [0, 1, 0], limbProximity: 0 };
  }

  /* Azimuth, compressed by exactly the ratio the CSS projection used, so the
     body appears where the composition has always put it and the cross-fade
     from the CSS scene to the shader does not slide it sideways. */
  const delta = bearingDelta(azimuthDeg, facingDeg);
  const displayAz = facingDeg + delta * (horizontalFovDeg / HORIZONTAL_FOV_DEG);

  /* Altitude, mapped so 0° is the limb and VERTICAL_FOV_DEG is the top of the
     frame. Below the limb it keeps going at the same rate, because a body that
     has just set must be just BEHIND the edge — near enough for its glow to
     still reach round it — rather than snapped to some floor. */
  const span = FRAME_TOP_DEG - LIMB_ALTITUDE_DEG;
  const displayAlt = LIMB_ALTITUDE_DEG + (altitudeDeg / VERTICAL_FOV_DEG) * span;

  const alt = (displayAlt * Math.PI) / 180;
  const az = (displayAz * Math.PI) / 180;
  const cos = Math.cos(alt);

  return {
    direction: [cos * Math.sin(az), cos * Math.cos(az), Math.sin(alt)],
    /* Ramped over 6° of real altitude either side of the horizon — the span
       over which a real sunset's colour and shape actually change. */
    limbProximity: clamp01(1 - Math.abs(altitudeDeg) / 6),
  };
}
