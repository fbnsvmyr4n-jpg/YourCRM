import type { SolarPhase, SolarSnapshot } from "../solar/types";

/**
 * Naming the part of the cycle we are in.
 *
 * The labels are for **semantic grouping only** — §10 is emphatic about this
 * and it is the rule most implementations of this idea break. Nothing visual
 * may be selected by phase; every colour and every intensity is a continuous
 * function of the sun's altitude. The phase exists so that a developer panel
 * can say "golden hour", a test can assert an ordering, and a person can talk
 * about what they are looking at. If a phase name ever appears in a component,
 * the eight hard presets this design exists to avoid have quietly returned.
 *
 * ## The thresholds
 *
 * Solar altitude, in degrees, using the standard astronomical twilights rather
 * than invented numbers. They are named constants because §9 requires it, and
 * because a threshold written inline is a threshold nobody can find later.
 */

/** Astronomical twilight. Below this the sky is as dark as it gets. */
export const ASTRONOMICAL_DEG = -18;

/** Civil twilight. Roughly where artificial light becomes necessary outdoors. */
export const CIVIL_DEG = -6;

/** The horizon itself, refraction included — see `HORIZON_DEG` in the solar wrapper. */
export const HORIZON_DEG = -0.35;

/** The top of golden hour: above this the light is no longer warm and raking. */
export const GOLDEN_DEG = 6;

/** Above this the sun reads as simply "up", with no directional character. */
export const FULL_DAY_DEG = 12;

/**
 * The phase, from altitude and direction of travel.
 *
 * Direction is the half of this that altitude cannot supply. The sun passes 3°
 * twice a day: once climbing, which is sunrise, and once falling, which is
 * golden hour. A classifier that reads only the number describes both as the
 * same thing, and the cycle loses its second half.
 *
 * Total by construction — every finite altitude lands in exactly one band on
 * each side, and the bands share their boundaries so there is no altitude that
 * belongs to none of them.
 */
export function classifyPhase(snapshot: Pick<SolarSnapshot, "altitudeDeg" | "rising">): SolarPhase {
  const { altitudeDeg: altitude, rising } = snapshot;

  // Not reachable from `solarSnapshot`, which is swept for finite values — but
  // this function is exported and someone will eventually hand it a computed
  // number. Night is the safe answer: it is the state that assumes least.
  if (!Number.isFinite(altitude)) return "night";

  if (altitude < ASTRONOMICAL_DEG) return "night";

  // The two sides mirror each other around the horizon, and the boundary that
  // matters most on both is the horizon itself. An earlier version started
  // "sunrise" at civil twilight, which named the sun as risen while it was
  // still three degrees underground — the ascending half had one fewer band
  // than the descending one, and the pre-dawn glow had nowhere to live.
  if (rising) {
    if (altitude < HORIZON_DEG) return "dawn";
    if (altitude < GOLDEN_DEG) return "sunrise";
    if (altitude < FULL_DAY_DEG) return "morning";
    return "day";
  }

  if (altitude < CIVIL_DEG) return "blue-hour";
  if (altitude < HORIZON_DEG) return "sunset";
  if (altitude < GOLDEN_DEG) return "golden-hour";
  return "day";
}

/**
 * The order phases occur in over a day, starting from the middle of the night.
 *
 * Exported for the developer panel's jump buttons and for tests that assert the
 * cycle actually cycles. Deliberately a separate list from `SOLAR_PHASES`,
 * which is the type's source: this one is a claim about *sequence*, and
 * conflating "these are the phases" with "this is their order" is how the two
 * drift apart.
 */
export const PHASE_SEQUENCE: readonly SolarPhase[] = [
  "night",
  "dawn",
  "sunrise",
  "morning",
  "day",
  "golden-hour",
  "sunset",
  "blue-hour",
] as const;

/** What to call a phase on screen. */
export const PHASE_LABELS: Record<SolarPhase, string> = {
  night: "Night",
  dawn: "Dawn",
  sunrise: "Sunrise",
  morning: "Morning",
  day: "Day",
  "golden-hour": "Golden hour",
  sunset: "Sunset",
  "blue-hour": "Blue hour",
};
