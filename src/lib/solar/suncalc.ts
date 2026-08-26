import { getMoonIllumination, getMoonPosition, getPosition, getTimes } from "suncalc";
import type { Coordinates, MoonSnapshot, SolarSnapshot } from "./types";

/**
 * The only file in this project that imports SunCalc.
 *
 * Everything above talks to `solarSnapshot` and `moonSnapshot`, so replacing
 * the astronomy library is a one-file change. That is worth the indirection
 * for a dependency that is small, unchanged for years, and whose published
 * documentation does not match what it actually returns.
 *
 * ## The conventions, measured rather than read
 *
 * SunCalc's README describes altitude and azimuth in **radians**, with azimuth
 * measured **from south**. Version 2.0.1 — pinned here — does neither. Probed
 * against known positions before any of this was written:
 *
 * | measured                    | value    | means                    |
 * | --------------------------- | -------- | ------------------------ |
 * | Cape Town, solar noon, alt  | 44.75    | degrees (almanac: 44.7)  |
 * | Cape Town, solar noon, az   | 0.00     | due north — compass      |
 * | London, solar noon, az      | 180.00   | due south — compass      |
 * | sunrise azimuth             | ~77      | ENE                      |
 * | sunset azimuth              | ~283     | WNW                      |
 * | altitude at sunrise/sunset  | -0.35    | refraction + solar disc  |
 *
 * So: **degrees, and azimuth is a compass bearing from north, clockwise.**
 *
 * The package's own bundled type definitions say the same thing in as many
 * words — "all angles are in degrees; azimuth is north-based clockwise" — and
 * were found only after the probe. Which is the right order: the measurement
 * is what makes the documentation trustworthy, not the other way round. The
 * separately published `@types/suncalc` describes the OLD radians API and was
 * removed, because a type definition that contradicts the library is worse
 * than none.
 *
 * Following the specification's type names (`sunAltitudeRad`) would have meant
 * converting degrees to degrees a second time. That produces an altitude of
 * 2390°, which is not an error anything would catch — it is a number, it is
 * finite, and it would simply have put the sun in an absurd place while every
 * test that only checked for NaN passed. This is why the angle convention gets
 * verified before it gets used, not after the sun looks wrong.
 *
 * The horizon being at −0.35° rather than 0 is also real and worth keeping:
 * the atmosphere refracts the sun's image upward by about half a degree, so it
 * is visibly above the horizon when it is geometrically just below it. Sunrise
 * genuinely happens before the sun rises.
 */

/** Degrees below the true horizon at which the sun's disc appears to sit on it. */
export const HORIZON_DEG = -0.35;

/**
 * The step used to tell whether the sun is climbing or falling.
 *
 * Five minutes. Long enough that the altitude difference is far larger than any
 * floating-point noise even at the turning point, short enough that the answer
 * is about now rather than about later.
 */
const DIRECTION_STEP_MS = 5 * 60_000;

/**
 * A `Date` from SunCalc, as a timestamp — or null when the event does not happen.
 *
 * Two different absences to survive, and they are not the same shape. Version
 * 2.0.1 returns `null` for an event that does not occur at this latitude, which
 * fails loudly on `.getTime()`. Version 1.x returned a `Date` whose time is
 * `NaN`, which fails at nothing at all: `NaN` compares false against every
 * bound, propagates through arithmetic without complaint, and arrives in the
 * render state as an invisible corruption.
 *
 * Both are handled because a library this quiet is exactly the one to be
 * pessimistic about across versions, and because the NaN form is the one that
 * would take a day to find.
 */
export function eventTime(value: Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Where the sun is, and today's events, for one place and one instant.
 *
 * A pure function of its arguments — no clock is read inside it, nothing is
 * cached across calls, and the same inputs always produce the same output.
 * That is what makes it possible to sweep the entire globe across a year in a
 * test, which is where the failures actually live.
 */
export function solarSnapshot(at: Date, where: Coordinates): SolarSnapshot {
  const { latitude, longitude } = where;

  const position = getPosition(at, latitude, longitude);
  const times = getTimes(at, latitude, longitude);

  // Is the sun climbing? Read from its own motion over a short step rather than
  // from the clock. Comparing against solar noon breaks in exactly the place
  // this has to work — a polar day, where the sun circles without ever setting
  // and "before noon" says nothing about whether it is rising.
  const later = getPosition(new Date(at.getTime() + DIRECTION_STEP_MS), latitude, longitude);

  const sunrise = eventTime(times.sunrise);
  const sunset = eventTime(times.sunset);
  const solarNoon = eventTime(times.solarNoon) ?? at.getTime();

  return {
    timestamp: at.getTime(),
    altitudeDeg: position.altitude,
    azimuthDeg: normaliseBearing(position.azimuth),
    rising: later.altitude > position.altitude,
    sunrise,
    sunset,
    dawn: eventTime(times.dawn),
    dusk: eventTime(times.dusk),
    // Solar noon is the moment the sun crosses the meridian, which happens
    // every day everywhere — including where it never rises. It is the one
    // event that can be relied on as the anchor for a polar day.
    solarNoon,
    solarNoonAzimuthDeg: normaliseBearing(
      getPosition(new Date(solarNoon), latitude, longitude).azimuth
    ),
    // `||` rather than `&&`, though nothing can currently tell them apart:
    // swept 60–80°N across a full year, this library returns both events or
    // neither, never one. Recorded rather than tested, because a test that
    // cannot fail is worse than an honest comment — and `||` is the safer of
    // two equivalent readings, treating a half-answer as the polar case.
    polar: sunrise === null || sunset === null,
  };
}

/**
 * Where the moon is and how much of it is lit.
 *
 * `getMoonIllumination` takes no location — the illuminated fraction is a
 * property of the sun-earth-moon geometry, not of the observer. Only the
 * position is local.
 */
export function moonSnapshot(at: Date, where: Coordinates): MoonSnapshot {
  const position = getMoonPosition(at, where.latitude, where.longitude);
  const illumination = getMoonIllumination(at);

  return {
    altitudeDeg: position.altitude,
    azimuthDeg: normaliseBearing(position.azimuth),
    illuminatedFraction: illumination.fraction,
    /* Degrees, like everything else this library returns — see the table above.
       Finite even at the zenith, where the angle is formally undefined. */
    parallacticAngleDeg: Number.isFinite(position.parallacticAngle)
      ? position.parallacticAngle
      : 0,
  };
}

/**
 * Fold a bearing into [0, 360).
 *
 * Measured output already sits in that range, but a bearing is the value most
 * likely to arrive slightly outside it — from a version change, or from any
 * future arithmetic on it — and a scene projection handed 361° or −5° would
 * place the sun off the edge of the frame rather than one degree from where it
 * belongs. The modulo is written to survive negatives, which the bare `%`
 * operator does not.
 */
function normaliseBearing(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}
