/**
 * The vocabulary the login environment is built from.
 *
 * Three subsystems, and each one only knows about the layer below it: location
 * answers *where*, the solar engine answers *where is the sun*, and the
 * environment model answers *what should the world look like*. Nothing in here
 * knows about React, CSS or an image, which is what lets all of it be tested
 * without a browser.
 */

/**
 * A place on Earth.
 *
 * `source` travels with the numbers rather than being tracked separately,
 * because how a coordinate was obtained changes what may be done with it — a
 * default is a guess and should never be presented as the user's location.
 */
export type CoordinateSource = "gps" | "ip" | "default";

export type Coordinates = {
  latitude: number;
  longitude: number;
  source: CoordinateSource;
};

/**
 * The phases, in the order they occur.
 *
 * An `as const` array with the type derived from it, per this project's rule:
 * a union typed by hand drifts from the array that iterates it, and every
 * exhaustiveness check downstream is only as good as the list it was built on.
 */
export const SOLAR_PHASES = [
  "night",
  "dawn",
  "sunrise",
  "morning",
  "day",
  "golden-hour",
  "sunset",
  "blue-hour",
] as const;

export type SolarPhase = (typeof SOLAR_PHASES)[number];

/**
 * Where the sun is, and when today's events happen.
 *
 * **Angles are DEGREES.** The specification's type names say radians, which was
 * true of SunCalc 1.x and is not true of the version pinned here — see the note
 * in `suncalc.ts`. Degrees are also what a person can sanity-check: "the sun is
 * 44° up and bearing 350°" is verifiable against an almanac, where 0.77 radians
 * is not.
 *
 * Event times are `number | null`. Null is not a failure — above the Arctic
 * Circle in June there genuinely is no sunrise, and a date is the wrong type
 * for a thing that does not happen.
 */
export type SolarSnapshot = {
  /** The instant this describes. */
  timestamp: number;

  /** Degrees above the horizon. Negative when the sun is down. */
  altitudeDeg: number;
  /** Compass bearing in degrees: 0 = north, 90 = east, 180 = south. */
  azimuthDeg: number;

  /** Null on days when the event does not occur at this latitude. */
  sunrise: number | null;
  sunset: number | null;
  dawn: number | null;
  dusk: number | null;
  /** Solar noon always exists — the sun is always at its highest at some point. */
  solarNoon: number;

  /**
   * True when this date has no sunrise or no sunset at this latitude.
   *
   * Carried explicitly rather than left for each consumer to infer from nulls,
   * so the polar case is handled once and deliberately instead of six times by
   * accident.
   */
  polar: boolean;
};

/**
 * Where the moon is and how much of it is lit.
 *
 * Night is the half of the cycle most day/night implementations abandon to a
 * flat dark rectangle. The moon is what stops that: it moves, it changes shape
 * across the month, and some nights it is simply not there — all of which is
 * computable from the same coordinates and timestamp as the sun.
 */
export type MoonSnapshot = {
  altitudeDeg: number;
  azimuthDeg: number;
  /** 0 = new, 1 = full. The moon's contribution scales with this. */
  illuminatedFraction: number;
};
