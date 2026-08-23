import type { Coordinates, CoordinateSource } from "./types";

/**
 * Coordinates, validated and deliberately blunted.
 *
 * **Rounded to 0.1° at the point of entry, on purpose.** That is roughly 11 km,
 * which moves sunset by well under a minute — invisible in the thing being
 * built. What it buys is that full-precision GPS never enters the system at
 * all: there is nothing to leak, nothing to log by accident, and no retention
 * question to get wrong later. A privacy rule that depends on every future
 * caller remembering it is not a rule; discarding the precision at the door is.
 *
 * The coordinates never reach the server either. Solar geometry is computed
 * locally, so the browser is the only thing that ever knows where the user is.
 */

/**
 * How much precision the environment actually needs.
 *
 * One decimal place. Sunset at 0.1° of latitude differs by seconds, and the sun
 * moves half its own width in that time — below the threshold of anything this
 * renders.
 */
const PRECISION = 1;

function round(value: number): number {
  // `Number(...toFixed())` rather than `Math.round(v * 10) / 10`: the latter
  // reintroduces float noise (0.1 + 0.2 arithmetic), and the whole point here
  // is that what comes out is exactly as coarse as it claims to be.
  return Number(value.toFixed(PRECISION));
}

/**
 * Accept a coordinate pair, or refuse it.
 *
 * Returns null rather than throwing or clamping. Clamping is the dangerous
 * option: a latitude of 200 clamped to 90 is a confident answer to a question
 * nobody asked, and the environment would render the Arctic to somebody whose
 * browser returned nonsense.
 *
 * `NaN` is checked first and explicitly. It fails every comparison silently, so
 * a range check alone lets it through — `NaN >= -90` is false, but so is
 * `NaN > 90`, and a naive `!(v < -90 || v > 90)` accepts it.
 */
export function validateCoordinates(
  latitude: unknown,
  longitude: unknown,
  source: CoordinateSource
): Coordinates | null {
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;

  return {
    latitude: round(latitude),
    longitude: round(longitude),
    source,
  };
}

/**
 * Where the environment renders when nothing else is known.
 *
 * Somebody has to see something, and a location the product's own author can
 * check against the window is worth more than a neutral one like 0°,0° — which
 * is in the Atlantic, has no seasons worth speaking of, and would make every
 * fallback look identical to a correctly-resolved equatorial user.
 */
export const DEFAULT_LOCATION: Coordinates = {
  latitude: -33.9,
  longitude: 18.4,
  source: "default",
};
