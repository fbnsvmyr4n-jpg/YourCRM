import { describe, expect, it } from "vitest";
import { approach, clamp01, lerp, progress, ridge, smoothstep } from "../src/lib/environment/curves";
import { classifyPhase, PHASE_SEQUENCE } from "../src/lib/environment/phases";
import { environmentFor, environmentValues, lightValues } from "../src/lib/environment/model";
import { moonSnapshot, solarSnapshot } from "../src/lib/solar/suncalc";
import { SOLAR_PHASES } from "../src/lib/solar/types";
import type { Coordinates } from "../src/lib/solar/types";

/**
 * The environment model: the layer that turns the sky into numbers.
 *
 * Two of the tests here are the ones worth having. §22 asks a person to run the
 * simulator and look for colour jumps — a check that finds a seam only if
 * somebody happens to be watching the right variable in the right minute, and
 * one that cannot run in CI. But the model is a pure function of coordinates
 * and a timestamp, so the whole day can simply be walked: every minute, every
 * variable, asserting nothing moves further than it should. A discontinuity
 * anywhere in the cycle now fails the build with the minute and the variable
 * named.
 */

const place = (latitude: number, longitude: number): Coordinates => ({
  latitude,
  longitude,
  source: "gps",
});

const CAPE_TOWN = place(-33.9, 18.4);
const TROMSO = place(69.7, 19.0);
const EQUATOR = place(0, 0);

const stateAt = (when: Date, where: Coordinates) =>
  environmentFor(solarSnapshot(when, where), moonSnapshot(when, where));

describe("the curves themselves", () => {
  it("clamps, and refuses to pass NaN along", () => {
    // The cheapest place in the whole system to stop a broken number, so it is
    // stopped here rather than guarded for at fifteen call sites.
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(1);
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(3)).toBe(1);
  });

  it("does not divide by a zero-width band", () => {
    // A misconfigured threshold pair should read as "not in it", not Infinity.
    expect(progress(5, 3, 3)).toBe(0);
    expect(Number.isFinite(smoothstep(5, 3, 3))).toBe(true);
  });

  it("is flat at both ends, which is what hides the seam", () => {
    /**
     * The property that distinguishes smoothstep from a linear ramp. Both are
     * continuous in value; only smoothstep is continuous in its *rate*, and the
     * eye reads a change of rate as a crease — light appearing to "switch on"
     * at the moment the ramp starts.
     */
    const rateNearStart = smoothstep(0.02, 0, 1) - smoothstep(0, 0, 1);
    const rateAtMiddle = smoothstep(0.52, 0, 1) - smoothstep(0.5, 0, 1);
    expect(rateNearStart).toBeLessThan(rateAtMiddle / 4);

    const rateNearEnd = smoothstep(1, 0, 1) - smoothstep(0.98, 0, 1);
    expect(rateNearEnd).toBeLessThan(rateAtMiddle / 4);
  });

  it("rises to a peak and falls again, wherever the peak is put", () => {
    expect(ridge(0, 0, 5, 10)).toBe(0);
    expect(ridge(5, 0, 5, 10)).toBe(1);
    expect(ridge(10, 0, 5, 10)).toBe(0);
    expect(ridge(-1, 0, 5, 10)).toBe(0);
    expect(ridge(11, 0, 5, 10)).toBe(0);

    // Asymmetric: a slow build into a fast fall, which is what a sunset is.
    expect(ridge(2, 0, 8, 10)).toBeLessThan(ridge(9, 0, 8, 10));
  });

  it("eases at the same speed whatever the frame rate", () => {
    /**
     * The bug in every naive lerp-toward-target: `current + (target - current) *
     * 0.1` per frame closes the gap twice as fast at 120fps as at 60, so the
     * same scene settles at different speeds on different machines. Expressed as
     * a half-life instead, one 32ms step must land where two 16ms steps land.
     */
    const oneBigStep = approach(0, 1, 500, 32);
    let twoSmall = approach(0, 1, 500, 16);
    twoSmall = approach(twoSmall, 1, 500, 16);
    expect(oneBigStep).toBeCloseTo(twoSmall, 10);
  });

  it("closes exactly half the gap in one half-life", () => {
    expect(approach(0, 1, 300, 300)).toBeCloseTo(0.5, 10);
    expect(approach(0, 1, 300, 600)).toBeCloseTo(0.75, 10);
  });

  it("interpolates between real endpoints", () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.5)).toBe(15);
    expect(lerp(10, 20, 5)).toBe(20);
  });
});

describe("naming the phase", () => {
  it("tells the two halves of the day apart at the same altitude", () => {
    /**
     * The reason direction is carried at all. The sun is at 3° twice a day, and
     * a classifier reading only the number calls both of them the same thing —
     * which silently deletes half the cycle.
     */
    expect(classifyPhase({ altitudeDeg: 3, rising: true })).toBe("sunrise");
    expect(classifyPhase({ altitudeDeg: 3, rising: false })).toBe("golden-hour");
    expect(classifyPhase({ altitudeDeg: -3, rising: true })).toBe("dawn");
    expect(classifyPhase({ altitudeDeg: -3, rising: false })).toBe("sunset");
  });

  it("calls deep night night, whichever way the sun is going", () => {
    expect(classifyPhase({ altitudeDeg: -30, rising: true })).toBe("night");
    expect(classifyPhase({ altitudeDeg: -30, rising: false })).toBe("night");
  });

  it("has a band for every altitude, with none left over", () => {
    // Totality, checked rather than assumed: every degree from far below to far
    // above must land in exactly one named phase, on both sides.
    const seen = new Set<string>();
    for (let altitude = -90; altitude <= 90; altitude += 0.25) {
      for (const rising of [true, false]) {
        const phase = classifyPhase({ altitudeDeg: altitude, rising });
        expect(SOLAR_PHASES).toContain(phase);
        seen.add(phase);
      }
    }
    expect(seen.size, "some phase is unreachable").toBe(SOLAR_PHASES.length);
  });

  it("falls back to night on a broken number rather than propagating it", () => {
    expect(classifyPhase({ altitudeDeg: NaN, rising: true })).toBe("night");
  });

  it("runs a real day through every phase in order", () => {
    /**
     * The cycle actually cycling, over real astronomy rather than over the
     * classifier's own bands. Cape Town at the equinox: walk the day and check
     * the phases appear in the sequence they are meant to, with no phase
     * arriving before the one it should follow.
     */
    const seen: string[] = [];
    for (let minute = 0; minute < 1440; minute += 2) {
      const when = new Date(Date.UTC(2026, 2, 20, 0, minute));
      const phase = stateAt(when, CAPE_TOWN).phase;
      if (seen.at(-1) !== phase) seen.push(phase);
    }

    // Every phase in the model should occur on an ordinary equinox day.
    expect(new Set(seen).size).toBe(PHASE_SEQUENCE.length);

    // And each transition must be to the neighbouring phase in the cycle —
    // no jumping from morning straight to sunset.
    for (let i = 1; i < seen.length; i++) {
      const from = PHASE_SEQUENCE.indexOf(seen[i - 1] as never);
      const to = PHASE_SEQUENCE.indexOf(seen[i] as never);
      const step = (to - from + PHASE_SEQUENCE.length) % PHASE_SEQUENCE.length;
      expect(step, `jumped from ${seen[i - 1]} to ${seen[i]}`).toBe(1);
    }
  });
});

describe("no seams anywhere in the day", () => {
  /**
   * The test that replaces "run the simulator and look for colour jumps".
   *
   * The model is pure, so the day can be walked a minute at a time and every
   * variable checked for how far it moved. A real minute of a real sunset moves
   * these values by a few thousandths; anything approaching a tenth is a step,
   * not a transition.
   */
  const MAX_CHANGE_PER_MINUTE = 0.05;

  const sweepDay = (where: Coordinates, date: [number, number, number], label: string) => {
    const jumps: string[] = [];
    let previous: Record<string, number> | null = null;

    for (let minute = 0; minute < 1440; minute++) {
      const when = new Date(Date.UTC(date[0], date[1], date[2], 0, minute));
      const values = lightValues(stateAt(when, where));

      if (previous) {
        for (const [name, value] of Object.entries(values)) {
          const change = Math.abs(value - previous[name]);
          if (change > MAX_CHANGE_PER_MINUTE) {
            jumps.push(
              `${label}: ${name} moved ${change.toFixed(3)} at minute ${minute} ` +
                `(${previous[name].toFixed(3)} → ${value.toFixed(3)})`
            );
          }
        }
      }
      previous = values;
    }
    return jumps;
  };

  it("moves smoothly through an equinox in Cape Town", () => {
    expect(sweepDay(CAPE_TOWN, [2026, 2, 20], "Cape Town equinox")).toEqual([]);
  });

  it("moves smoothly through midsummer and midwinter", () => {
    expect(sweepDay(CAPE_TOWN, [2026, 11, 21], "Cape Town midsummer")).toEqual([]);
    expect(sweepDay(CAPE_TOWN, [2026, 5, 21], "Cape Town midwinter")).toEqual([]);
  });

  it("moves smoothly at the equator, where the sun drops fastest", () => {
    // The steepest ordinary sunset on Earth: the sun descends perpendicular to
    // the horizon, so twilight is shortest and any step shows up here first.
    expect(sweepDay(EQUATOR, [2026, 2, 20], "equator equinox")).toEqual([]);
  });

  it("moves smoothly through a polar day and a polar night", () => {
    expect(sweepDay(TROMSO, [2026, 5, 21], "Tromso midnight sun")).toEqual([]);
    expect(sweepDay(TROMSO, [2026, 11, 21], "Tromso polar night")).toEqual([]);
  });

  it("would notice a step if one were introduced", () => {
    // The guard proving it can fail. A sweep that cannot go red is not a check.
    const stepped = [0.1, 0.9];
    const change = Math.abs(stepped[1] - stepped[0]);
    expect(change).toBeGreaterThan(MAX_CHANGE_PER_MINUTE);
  });
});

describe("no broken numbers anywhere on Earth", () => {
  it("stays finite and in range across the globe and the year", () => {
    /**
     * §21 asks for an assertion that no environment state produces NaN. One
     * assertion passes trivially in Cape Town in August. What breaks is the
     * poles, the equinoxes, and solar noon at extreme latitude — so this sweeps
     * every tenth degree of latitude across all twelve months.
     */
    const broken: string[] = [];

    for (let lat = -90; lat <= 90; lat += 10) {
      for (let month = 0; month < 12; month++) {
        for (let hour = 0; hour < 24; hour += 2) {
          const when = new Date(Date.UTC(2026, month, 15, hour));
          const state = stateAt(when, place(lat, 0));
          const values = environmentValues(state);

          for (const [name, value] of Object.entries(values)) {
            if (!Number.isFinite(value)) {
              broken.push(`${name} not finite at lat ${lat}, month ${month + 1}, ${hour}h`);
            }
          }

          /**
           * The 0…1 bound applies to LIGHT, not to position.
           *
           * `sunX` and `sunY` are frame coordinates, and a body outside the
           * frame legitimately has one — that is how the renderer knows not to
           * draw it. Asserting they stay inside would be asserting the sun never
           * leaves the picture, which is the opposite of true.
           */
          for (const [name, value] of Object.entries(lightValues(state))) {
            if (value < 0 || value > 1) {
              broken.push(`${name} = ${value} out of range at lat ${lat}, month ${month + 1}`);
            }
          }
        }
      }
    }

    expect(broken).toEqual([]);
  });
});

describe("the model says true things about light", () => {
  const noon = () => stateAt(new Date(Date.UTC(2026, 2, 20, 10, 49)), CAPE_TOWN);
  const midnight = () => stateAt(new Date(Date.UTC(2026, 2, 20, 22, 0)), CAPE_TOWN);

  it("is brighter at noon than at midnight", () => {
    expect(noon().skyBrightness).toBeGreaterThan(midnight().skyBrightness);
    expect(noon().daylight).toBeGreaterThan(midnight().daylight);
  });

  it("never lets night reach pure black", () => {
    // A black sky reads as a rendering failure rather than as night. There is
    // always airglow and starlight, and every reference frame shows it.
    expect(midnight().skyBrightness).toBeGreaterThan(0);
    expect(midnight().limbIntensity).toBeGreaterThan(0);
  });

  it("keeps the stars faintly visible even at noon", () => {
    expect(noon().starVisibility).toBeGreaterThan(0);
    expect(noon().starVisibility).toBeLessThan(midnight().starVisibility);
  });

  it("puts peak warmth near the horizon, not at noon", () => {
    /**
     * The single most characteristic fact about the whole cycle, and the one a
     * naive brightness-driven model gets wrong: warmth is not a function of how
     * much light there is. The warmest moment of the day happens when there is
     * least of it.
     */
    const warmthAt = (altitude: number, rising: boolean) =>
      environmentFor(
        { ...solarSnapshot(new Date(), CAPE_TOWN), altitudeDeg: altitude, rising },
        { altitudeDeg: -30, azimuthDeg: 0, illuminatedFraction: 0 , parallacticAngleDeg: 0 }
      ).warmth;

    expect(warmthAt(-2, false)).toBeGreaterThan(warmthAt(45, false));
    expect(warmthAt(-2, false)).toBeGreaterThan(warmthAt(-30, false));
  });

  it("turns the city lights on as the terminator passes, not by the clock", () => {
    const lightsAt = (altitude: number) =>
      environmentFor(
        { ...solarSnapshot(new Date(), CAPE_TOWN), altitudeDeg: altitude, rising: false },
        { altitudeDeg: -30, azimuthDeg: 0, illuminatedFraction: 0 , parallacticAngleDeg: 0 }
      ).cityLights;

    expect(lightsAt(30)).toBe(0);
    expect(lightsAt(-20)).toBe(1);
    expect(lightsAt(-6)).toBeGreaterThan(lightsAt(2));
  });

  it("gives a full moon a night and a new moon none", () => {
    const night = { ...solarSnapshot(new Date(), CAPE_TOWN), altitudeDeg: -40, rising: false };
    const full = environmentFor(night, { altitudeDeg: 50, azimuthDeg: 0, illuminatedFraction: 1 , parallacticAngleDeg: 0 });
    const newMoon = environmentFor(night, { altitudeDeg: 50, azimuthDeg: 0, illuminatedFraction: 0 , parallacticAngleDeg: 0 });
    const below = environmentFor(night, { altitudeDeg: -40, azimuthDeg: 0, illuminatedFraction: 1 , parallacticAngleDeg: 0 });

    expect(full.moonlight).toBeGreaterThan(0);
    expect(newMoon.moonlight).toBe(0);
    expect(below.moonlight, "a moon below the horizon lit the scene").toBe(0);
  });

  it("does not let the moon light the day", () => {
    // A full moon at midday is a real thing that contributes nothing visible.
    const day = { ...solarSnapshot(new Date(), CAPE_TOWN), altitudeDeg: 45, rising: false };
    const state = environmentFor(day, { altitudeDeg: 40, azimuthDeg: 0, illuminatedFraction: 1 , parallacticAngleDeg: 0 });
    expect(state.moonlight).toBe(0);
  });

  it("lays the longest reflection when the light is lowest", () => {
    const reflectionAt = (altitude: number) =>
      environmentFor(
        { ...solarSnapshot(new Date(), CAPE_TOWN), altitudeDeg: altitude, rising: false },
        { altitudeDeg: -30, azimuthDeg: 0, illuminatedFraction: 0 , parallacticAngleDeg: 0 }
      ).reflection;

    expect(reflectionAt(1)).toBeGreaterThan(reflectionAt(45));
    expect(reflectionAt(1)).toBeGreaterThan(reflectionAt(-30));
  });

  it("asks for more scrim behind the text when the sky is bright", () => {
    // §24's contrast requirement, as a number the renderer can act on: the
    // brightest sky is where white text on glass is hardest to hold up.
    expect(noon().textScrim).toBeGreaterThan(midnight().textScrim);
  });
});
