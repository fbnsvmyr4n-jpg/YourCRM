import { clamp01, ridge, smoothstep } from "./curves";
import { projectBodies } from "./projection";
import {
  ASTRONOMICAL_DEG,
  CIVIL_DEG,
  classifyPhase,
  FULL_DAY_DEG,
  GOLDEN_DEG,
  HORIZON_DEG,
} from "./phases";
import type { MoonSnapshot, SolarPhase, SolarSnapshot } from "../solar/types";

/**
 * What the world should look like, as numbers.
 *
 * The layer between "where is the sun" and "how is that drawn". Nothing here
 * knows about CSS, canvas or an image — it produces a set of 0…1 quantities
 * that a renderer interprets, which is what keeps the astronomy testable and
 * lets the scene be replaced without touching any of it.
 *
 * **Every value is a continuous function of solar altitude.** Not one of them
 * is selected by phase name. That is the whole design: eight presets
 * cross-faded produce visible steps at the boundaries, and no amount of easing
 * between them fixes it, because the steps are in the model rather than in the
 * animation.
 *
 * The variables also deliberately do not share a curve. Warmth peaks near the
 * horizon while brightness is still falling; reflection is longest at low sun
 * and gone at noon; the card's material lags everything so it reads as one
 * physical object under changing light rather than a thing that flickers. §10
 * asks for exactly this, and it is what stops the scene looking like a single
 * master dimmer being turned.
 */

export type EnvironmentState = {
  phase: SolarPhase;

  /** How much of the sun's own light there is. 0 through the night. */
  daylight: number;
  /** Overall sky luminance. Never quite 0 — there is always airglow and stars. */
  skyBrightness: number;
  /** How orange the light is. Peaks at the horizon, not at noon. */
  warmth: number;
  /** Atmospheric scattering: thickens near the horizon, thins overhead. */
  haze: number;

  /** The rim of scattered light along the horizon — the signature of the scene. */
  limbIntensity: number;
  /** How warm that rim is where the sun sits behind it. */
  limbWarmth: number;

  /** The sun's own brightness as a body: disc, bloom, rays. */
  sunIntensity: number;
  /** Light from the moon, scaled by how much of it is lit and how high it is. */
  moonlight: number;
  /** How strongly a light lays a specular track across water. */
  reflection: number;

  /** Stars and the Milky Way. Inverse to sky brightness, never switched off. */
  starVisibility: number;
  /** City lights on the unlit side, coming up as the terminator passes. */
  cityLights: number;

  /** The card's material: how light, how opaque, how much it glows. */
  glassLightness: number;
  glassOpacity: number;
  /** How much extra scrim the text needs to stay readable. */
  textScrim: number;

  /**
   * Where the sun and moon sit in the frame, 0…1 from the left and the top.
   *
   * Carried on the state so the renderer never does astronomy and never does
   * trigonometry — it reads two numbers and places a light. The projection
   * itself lives in one calibrated module, per §12.
   */
  sunX: number;
  sunY: number;
  /** How much of the sun's disc is above the limb, 0…1 — a ramp, not a switch. */
  sunVisible: number;
  moonX: number;
  moonY: number;
  moonVisible: number;
};

/**
 * The one place a scene's brightest and darkest are decided.
 *
 * Night is not zero. A pure black sky reads as a rendering failure rather than
 * as night — there is always airglow, starlight and scattered city light, and
 * the reference frames all show it. The floor is what keeps night a scene.
 */
const NIGHT_SKY_FLOOR = 0.04;

/**
 * How much light a full moon at its highest actually contributes.
 *
 * Small. A full moon is roughly four hundred thousand times fainter than the
 * sun, and while nothing here is photometric, the ratio matters: moonlight that
 * competes with daylight makes every night look like an underexposed day. It is
 * enough to shape the scene and lay a reflection, not enough to light it.
 */
const MOONLIGHT_CEILING = 0.16;

/**
 * Turn the sky into numbers.
 *
 * Pure: same inputs, same output, no clock read inside. That is what allows the
 * whole day to be swept a minute at a time in a test, and what makes the
 * simulator's scrubber honest — asking for 3am produces 3am, not 3am blended
 * with whatever the real time happens to be.
 */
export function environmentFor(sun: SolarSnapshot, moon: MoonSnapshot): EnvironmentState {
  const altitude = Number.isFinite(sun.altitudeDeg) ? sun.altitudeDeg : ASTRONOMICAL_DEG - 1;

  // How much sun there is. Rises from first light to full day.
  const daylight = smoothstep(altitude, CIVIL_DEG, FULL_DAY_DEG);

  // The sky brightens earlier than the ground does — it is lit by scattering
  // long before the sun clears the horizon, which is what makes dawn readable
  // before sunrise.
  const skyBrightness =
    NIGHT_SKY_FLOOR + (1 - NIGHT_SKY_FLOOR) * smoothstep(altitude, ASTRONOMICAL_DEG, GOLDEN_DEG);

  /**
   * Warmth peaks below the horizon, not at it.
   *
   * The deepest colour in a sunset happens once the sun's disc is already gone
   * and its light is passing through the most atmosphere. Peaking at 0° would
   * make the warmest moment the one where the sun is still visible, which reads
   * as wrong even to somebody who could not say why.
   */
  const warmth = ridge(altitude, ASTRONOMICAL_DEG, HORIZON_DEG - 2, GOLDEN_DEG + 8);

  // Thickest when the light is travelling furthest through the atmosphere.
  const haze = ridge(altitude, ASTRONOMICAL_DEG, 0, FULL_DAY_DEG + 20) * 0.7 + daylight * 0.3;

  /**
   * The limb is never absent.
   *
   * Present in every reference frame including full night, where it is the only
   * thing separating the planet from space. Its floor is what stops the horizon
   * becoming an invisible edge.
   */
  const limbIntensity = 0.18 + 0.82 * smoothstep(altitude, ASTRONOMICAL_DEG - 6, GOLDEN_DEG);
  const limbWarmth = ridge(altitude, ASTRONOMICAL_DEG, HORIZON_DEG, GOLDEN_DEG + 4);

  // The sun as a body only exists once it is near enough the horizon to be in
  // frame, and is at its most dramatic as it crosses.
  const sunIntensity = smoothstep(altitude, ASTRONOMICAL_DEG + 6, GOLDEN_DEG);

  /**
   * Moonlight, and the reason night is worth rendering at all.
   *
   * Three things gate it, and all three are real: the moon has to be up, it has
   * to be lit, and the sun has to be down. A full moon at midday contributes
   * nothing visible, and a new moon at midnight contributes nothing at all —
   * both of which are correct, and both of which make some nights darker than
   * others in a way that is true rather than random.
   */
  const moonUp = smoothstep(moon.altitudeDeg, -6, 20);
  const sunGone = 1 - smoothstep(altitude, ASTRONOMICAL_DEG, CIVIL_DEG);
  const moonlight = clamp01(moonUp * clamp01(moon.illuminatedFraction) * sunGone) * MOONLIGHT_CEILING;

  /**
   * A specular track is a low-angle phenomenon.
   *
   * Overhead light scatters off water; light near the horizon skips along it and
   * throws a path toward the viewer. Strongest just above the horizon, gone by
   * mid-morning — which is precisely where the reference frames put it.
   */
  const sunTrack = ridge(altitude, ASTRONOMICAL_DEG, 1, GOLDEN_DEG + 10);
  const reflection = clamp01(sunTrack + moonlight * 4);

  // Stars fade as the sky brightens, but never leave: the daylight reference
  // still shows the Milky Way faintly.
  const starVisibility = clamp01(0.06 + 0.94 * (1 - smoothstep(altitude, CIVIL_DEG, GOLDEN_DEG)));

  /**
   * City lights follow the terminator, not the clock.
   *
   * They come up through civil twilight — the point at which people actually
   * turn lights on — and are full by the time the sky is dark. Tied to the sun's
   * angle, they sweep across the planet exactly as they do from orbit.
   */
  const cityLights = 1 - smoothstep(altitude, CIVIL_DEG, GOLDEN_DEG - 2);

  /**
   * The card's material.
   *
   * Deliberately the least reactive thing in the scene, and eased further by the
   * clock on top of this. It should read as one physical object under changing
   * light — glass does not become a different substance at dusk. The scrim is
   * the exception and moves the other way: the brighter the sky behind it, the
   * more the text needs holding up, which is §24's contrast requirement
   * expressed as a number the renderer can act on.
   */
  const glassLightness = 0.08 + 0.62 * daylight;
  const glassOpacity = 0.36 + 0.22 * daylight;
  const textScrim = clamp01(0.15 + 0.55 * skyBrightness);

  // One camera for both bodies, so a full moon standing opposite the setting
  // sun appears across the frame from it without anything arranging that.
  const bodies = projectBodies(sun, moon);

  return {
    phase: classifyPhase(sun),
    sunX: bodies.sun.x,
    sunY: bodies.sun.y,
    sunVisible: bodies.sun.visible,
    moonX: bodies.moon.x,
    moonY: bodies.moon.y,
    moonVisible: bodies.moon.visible,
    daylight,
    skyBrightness,
    warmth,
    haze: clamp01(haze),
    limbIntensity: clamp01(limbIntensity),
    limbWarmth,
    sunIntensity,
    moonlight,
    reflection,
    starVisibility,
    cityLights,
    glassLightness,
    glassOpacity,
    textScrim,
  };
}

/** Every numeric field, for the global finite sweep and the panel's inspector. */
export function environmentValues(state: EnvironmentState): Record<string, number> {
  const { phase: _phase, ...numbers } = state;
  return numbers;
}

/**
 * The quantities that describe LIGHT, as opposed to geometry.
 *
 * These are what §22's "no sudden colour jumps" is actually about, and what the
 * seam sweep measures. The distinction matters because the fields left out are
 * not sloppier — they are checked by a test that knows what smooth means for
 * them:
 *
 *  - `sunX`/`sunY` and the moon's carry the projection's one real
 *    discontinuity, at the antipode of the camera, which is permanently
 *    off-screen. `tests/projection.test.ts` sweeps them scoped to the frame.
 *  - `sunVisible`/`moonVisible` are continuous but genuinely STEEP: a disc half
 *    a degree wide crosses the horizon in about two minutes, so the value
 *    legitimately travels most of its range in that time. A per-minute
 *    threshold tuned for light would read real physics as a fault.
 *
 * A single sweep over everything would have to loosen its threshold until it
 * could no longer see the thing it exists to catch.
 */
export const LIGHT_VALUES = [
  "daylight",
  "skyBrightness",
  "warmth",
  "haze",
  "limbIntensity",
  "limbWarmth",
  "sunIntensity",
  "moonlight",
  "reflection",
  "starVisibility",
  "cityLights",
  "glassLightness",
  "glassOpacity",
  "textScrim",
] as const;

export function lightValues(state: EnvironmentState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of LIGHT_VALUES) out[key] = state[key];
  return out;
}
