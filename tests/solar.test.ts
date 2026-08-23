import { describe, expect, it } from "vitest";
import { DEFAULT_LOCATION, validateCoordinates } from "../src/lib/solar/coordinates";
import { eventTime, HORIZON_DEG, moonSnapshot, solarSnapshot } from "../src/lib/solar/suncalc";
import { SOLAR_PHASES } from "../src/lib/solar/types";
import type { Coordinates } from "../src/lib/solar/types";

/**
 * The astronomy, checked against the sky rather than against itself.
 *
 * This is the layer where being wrong is invisible: a sun placed thirty degrees
 * from where it belongs still renders a beautiful scene, and nothing throws.
 * So the assertions here are against published positions and against physics,
 * not against whatever the code happens to return.
 */

const at = (iso: string) => new Date(iso);
const place = (latitude: number, longitude: number): Coordinates => ({
  latitude,
  longitude,
  source: "gps",
});

const CAPE_TOWN = place(-33.9, 18.4);
const LONDON = place(51.5, -0.1);
const TROMSO = place(69.7, 19.0); // inside the Arctic Circle
const EQUATOR = place(0, 0);

describe("the angles are the ones the library actually returns", () => {
  /**
   * The defect this exists to prevent. SunCalc's README documents radians with
   * azimuth measured from south; version 2.0.1 returns degrees as a compass
   * bearing from north. Building on the documentation would have converted
   * degrees to degrees again — producing an altitude of 2390°, which is finite,
   * is not NaN, and would have passed every check except one that knew what the
   * answer should be.
   */
  it("reports altitude in degrees, matching the almanac", () => {
    // Cape Town, 23 Aug 2026, solar noon. Solar declination is about +11.4°,
    // so the maximum altitude is 90 − |−33.9 − 11.4| ≈ 44.7°.
    const noon = solarSnapshot(at("2026-08-23T10:49:00Z"), CAPE_TOWN);
    expect(noon.altitudeDeg).toBeGreaterThan(43.5);
    expect(noon.altitudeDeg).toBeLessThan(45.5);
  });

  it("reports azimuth as a compass bearing from north", () => {
    // The hemispheres disagree about where the midday sun is, and that
    // disagreement is the cleanest possible test of the convention.
    const capeTown = solarSnapshot(at("2026-08-23T10:49:00Z"), CAPE_TOWN);
    const london = solarSnapshot(at("2026-08-23T12:03:00Z"), LONDON);

    // Southern hemisphere: the midday sun is due north.
    expect(Math.min(capeTown.azimuthDeg, 360 - capeTown.azimuthDeg)).toBeLessThan(3);
    // Northern hemisphere: due south.
    expect(london.azimuthDeg).toBeGreaterThan(177);
    expect(london.azimuthDeg).toBeLessThan(183);
  });

  it("puts sunrise in the east and sunset in the west", () => {
    const times = solarSnapshot(at("2026-08-23T10:00:00Z"), CAPE_TOWN);
    const rise = solarSnapshot(new Date(times.sunrise!), CAPE_TOWN);
    const set = solarSnapshot(new Date(times.sunset!), CAPE_TOWN);

    expect(rise.azimuthDeg).toBeGreaterThan(45);
    expect(rise.azimuthDeg).toBeLessThan(135);
    expect(set.azimuthDeg).toBeGreaterThan(225);
    expect(set.azimuthDeg).toBeLessThan(315);
  });

  it("puts the sun a little below true horizontal at sunrise", () => {
    // Not a rounding artefact: the atmosphere refracts the sun's image upward
    // by roughly half a degree, so it is visible while geometrically still
    // below the horizon. Asserted because a future version that "fixed" this
    // to 0 would shift every dawn threshold built on it.
    const times = solarSnapshot(at("2026-08-23T10:00:00Z"), CAPE_TOWN);
    const rise = solarSnapshot(new Date(times.sunrise!), CAPE_TOWN);
    expect(rise.altitudeDeg).toBeCloseTo(HORIZON_DEG, 1);
  });

  it("keeps every bearing inside one full turn", () => {
    for (let hour = 0; hour < 24; hour++) {
      const snap = solarSnapshot(at(`2026-08-23T${String(hour).padStart(2, "0")}:00:00Z`), CAPE_TOWN);
      expect(snap.azimuthDeg).toBeGreaterThanOrEqual(0);
      expect(snap.azimuthDeg).toBeLessThan(360);
    }
  });
});

describe("places where the sun does not rise", () => {
  it("returns null rather than a broken date inside the Arctic Circle", () => {
    /**
     * The version pinned here returns `null`, which at least fails loudly.
     * Version 1.x returned a `Date` whose time is NaN, which fails at nothing:
     * it compares false against every bound and propagates through arithmetic
     * into the render state without one exception being raised. The wrapper
     * handles both; this proves the case exists.
     */
    const midsummer = solarSnapshot(at("2026-06-21T12:00:00Z"), TROMSO);
    expect(midsummer.sunrise).toBeNull();
    expect(midsummer.sunset).toBeNull();
    expect(midsummer.polar).toBe(true);
  });

  it("flags the polar night too, not only the midnight sun", () => {
    const midwinter = solarSnapshot(at("2026-12-21T12:00:00Z"), TROMSO);
    expect(midwinter.polar).toBe(true);
  });

  it("still gives a usable sun position when there are no events", () => {
    // This is what the environment falls back to: the sun is somewhere, always,
    // whether or not it crossed the horizon today.
    const midsummer = solarSnapshot(at("2026-06-21T00:00:00Z"), TROMSO);
    expect(Number.isFinite(midsummer.altitudeDeg)).toBe(true);
    // Midnight inside the Arctic Circle in June: still up.
    expect(midsummer.altitudeDeg).toBeGreaterThan(0);
    expect(Number.isFinite(midsummer.solarNoon)).toBe(true);
  });

  it("does not flag an ordinary latitude as polar", () => {
    // The guard has to be capable of being false, or it is not a guard.
    expect(solarSnapshot(at("2026-06-21T12:00:00Z"), CAPE_TOWN).polar).toBe(false);
    expect(solarSnapshot(at("2026-12-21T12:00:00Z"), LONDON).polar).toBe(false);
  });
});

describe("nothing anywhere on Earth produces a broken number", () => {
  it("survives every latitude, every month, every hour", () => {
    /**
     * The spec asks for one assertion that no state is NaN. One assertion
     * passes trivially in Cape Town in August. The values that break are at the
     * poles, at the equinoxes, and at solar noon at extreme latitude — so this
     * sweeps the globe. A few thousand cases, no network, milliseconds.
     */
    const broken: string[] = [];

    for (let lat = -90; lat <= 90; lat += 10) {
      for (let month = 1; month <= 12; month++) {
        for (let hour = 0; hour < 24; hour += 3) {
          const when = at(
            `2026-${String(month).padStart(2, "0")}-15T${String(hour).padStart(2, "0")}:00:00Z`
          );
          const where = place(lat, 0);
          const sun = solarSnapshot(when, where);
          const moon = moonSnapshot(when, where);

          const numbers: Record<string, number> = {
            altitude: sun.altitudeDeg,
            azimuth: sun.azimuthDeg,
            solarNoon: sun.solarNoon,
            moonAltitude: moon.altitudeDeg,
            moonAzimuth: moon.azimuthDeg,
            moonFraction: moon.illuminatedFraction,
          };

          for (const [name, value] of Object.entries(numbers)) {
            if (!Number.isFinite(value)) broken.push(`${name} at lat ${lat}, month ${month}, ${hour}h`);
          }
        }
      }
    }

    expect(broken).toEqual([]);
  });
});

describe("the moon", () => {
  it("reports an illuminated fraction between none and all of it", () => {
    for (let day = 1; day <= 28; day++) {
      const { illuminatedFraction } = moonSnapshot(
        at(`2026-08-${String(day).padStart(2, "0")}T22:00:00Z`),
        CAPE_TOWN
      );
      expect(illuminatedFraction).toBeGreaterThanOrEqual(0);
      expect(illuminatedFraction).toBeLessThanOrEqual(1);
    }
  });

  it("goes through a full cycle across a month", () => {
    // A moon stuck at one fraction would light every night identically, which
    // is the thing having a moon at all is meant to avoid.
    const fractions = Array.from({ length: 30 }, (_, i) =>
      moonSnapshot(at(new Date(Date.UTC(2026, 7, i + 1, 22)).toISOString()), CAPE_TOWN)
        .illuminatedFraction
    );
    expect(Math.max(...fractions)).toBeGreaterThan(0.9);
    expect(Math.min(...fractions)).toBeLessThan(0.1);
  });
});

describe("coordinates are checked before they are trusted", () => {
  it("accepts a real place", () => {
    expect(validateCoordinates(-33.92, 18.42, "gps")).toEqual({
      latitude: -33.9,
      longitude: 18.4,
      source: "gps",
    });
  });

  it("blunts the precision on the way in", () => {
    /**
     * Deliberate, and the reason is privacy rather than tidiness: rounding here
     * means full-precision GPS never exists anywhere in the system, so there is
     * nothing to leak and no retention decision to get wrong later. 0.1° is
     * about 11 km and moves sunset by seconds.
     */
    const precise = validateCoordinates(-33.924869, 18.424055, "gps");
    expect(precise!.latitude).toBe(-33.9);
    expect(precise!.longitude).toBe(18.4);
  });

  it("refuses NaN, which a range check alone would let through", () => {
    // `NaN < -90` is false and `NaN > 90` is false, so a bounds test written as
    // a pair of comparisons accepts it silently.
    expect(validateCoordinates(NaN, 18.4, "gps")).toBeNull();
    expect(validateCoordinates(-33.9, NaN, "gps")).toBeNull();
    expect(validateCoordinates(Infinity, 0, "gps")).toBeNull();
  });

  it("refuses anything outside the world rather than clamping it", () => {
    // Clamping would answer a question nobody asked — rendering the Arctic to
    // somebody whose browser returned nonsense.
    expect(validateCoordinates(91, 0, "gps")).toBeNull();
    expect(validateCoordinates(-91, 0, "gps")).toBeNull();
    expect(validateCoordinates(0, 181, "gps")).toBeNull();
    expect(validateCoordinates(0, -181, "gps")).toBeNull();
  });

  it("accepts the exact edges of the world", () => {
    expect(validateCoordinates(90, 180, "gps")).not.toBeNull();
    expect(validateCoordinates(-90, -180, "gps")).not.toBeNull();
  });

  it("refuses values that are not numbers", () => {
    expect(validateCoordinates("-33.9", "18.4", "gps")).toBeNull();
    expect(validateCoordinates(null, null, "gps")).toBeNull();
    expect(validateCoordinates(undefined, undefined, "gps")).toBeNull();
  });

  it("keeps the source, because a default is not a location", () => {
    expect(validateCoordinates(0, 0, "ip")!.source).toBe("ip");
    expect(DEFAULT_LOCATION.source).toBe("default");
  });

  it("has a default that is a real, checkable place", () => {
    const snap = solarSnapshot(at("2026-08-23T10:49:00Z"), DEFAULT_LOCATION);
    expect(snap.polar).toBe(false);
    expect(snap.sunrise).not.toBeNull();
  });
});

describe("the phase list", () => {
  it("names every phase once, in order", () => {
    expect(new Set(SOLAR_PHASES).size).toBe(SOLAR_PHASES.length);
    expect(SOLAR_PHASES[0]).toBe("night");
    expect(SOLAR_PHASES.at(-1)).toBe("blue-hour");
  });
});

describe("the same inputs always give the same answer", () => {
  it("reads no clock of its own", () => {
    // Purity is what makes the sweeps above possible, and what will make the
    // simulator's scrubber honest: asking for 3am must produce 3am, not
    // 3am-blended-with-now.
    const when = at("2026-08-23T14:00:00Z");
    expect(solarSnapshot(when, CAPE_TOWN)).toEqual(solarSnapshot(when, CAPE_TOWN));
    expect(solarSnapshot(when, EQUATOR)).not.toEqual(solarSnapshot(when, CAPE_TOWN));
  });
});

describe("surviving a version that answers differently", () => {
  /**
   * SunCalc 2.0.1 returns `null` for an event that does not occur. Version 1.x
   * returned a `Date` whose time is NaN — an absence that fails at nothing,
   * compares false against every bound, and reaches the render state as an
   * invisible corruption rather than an error.
   *
   * Nothing in the library's current behaviour exercises that path, so it is
   * tested directly. A guard for a hazard that cannot presently occur is only
   * worth having if something proves it works.
   */
  it("treats an Invalid Date as an absent event, not as a number", () => {
    expect(eventTime(new Date("nonsense"))).toBeNull();
    expect(eventTime(null)).toBeNull();
    expect(eventTime(undefined)).toBeNull();
    expect(eventTime(new Date("2026-08-23T05:16:00Z"))).toBe(Date.UTC(2026, 7, 23, 5, 16));
  });
});
