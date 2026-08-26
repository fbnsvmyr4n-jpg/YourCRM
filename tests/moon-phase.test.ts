import { describe, expect, it } from "vitest";
import { moonSnapshot } from "../src/lib/solar/suncalc";
import { FRAGMENT_SHADER } from "../src/lib/environment/gl/shaders";

const CAPE_TOWN = { latitude: -33.9, longitude: 18.4, source: "default" } as const;
const at = (y: number, m: number, d: number, h = 21) =>
  moonSnapshot(new Date(Date.UTC(y, m, d, h)), CAPE_TOWN).illuminatedFraction;

/**
 * The moon shows its real phase, so a crescent night draws a crescent.
 *
 * Two things have to hold and they are tested separately, because they fail
 * separately: the NUMBER has to be the real illuminated fraction, and the
 * shader has to turn that number into a lit sphere rather than a lit disc.
 */
describe("the moon's illuminated fraction", () => {
  it("stays a fraction", () => {
    for (let d = 0; d < 60; d++) {
      const f = at(2026, 0, 1 + d);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it("completes a full cycle in a synodic month", () => {
    /**
     * 29.53 days, which is astronomy rather than a tolerance invented to pass.
     * A phase driven by anything other than the real ephemeris — a day counter,
     * a modulo of the date — would drift away from this within a couple of
     * months, and nobody would notice on any single night.
     */
    const peaks: number[] = [];
    let previous = at(2026, 0, 1);
    let rising = true;
    for (let d = 1; d < 200; d++) {
      const f = at(2026, 0, 1 + d);
      if (rising && f < previous) {
        peaks.push(d - 1);
        rising = false;
      }
      if (!rising && f > previous) rising = true;
      previous = f;
    }
    expect(peaks.length).toBeGreaterThan(4);
    const gaps = peaks.slice(1).map((p, i) => p - peaks[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeGreaterThan(29.0);
    expect(mean).toBeLessThan(30.1);
  });

  it("reaches both a full and a new moon inside one cycle", () => {
    let brightest = 0;
    let darkest = 1;
    for (let d = 0; d < 30; d++) {
      const f = at(2026, 1, 1 + d);
      brightest = Math.max(brightest, f);
      darkest = Math.min(darkest, f);
    }
    expect(brightest).toBeGreaterThan(0.98);
    expect(darkest).toBeLessThan(0.05);
  });
});

describe("the shader draws a sphere, not a lit disc", () => {
  it("derives the phase angle from the illuminated fraction", () => {
    // f = (1 + cos θ)/2, so θ = acos(2f − 1).
    expect(FRAGMENT_SHADER).toMatch(/acos\(clamp\(2\.0 \* uMoonIllumination - 1\.0/);
  });

  it("lights it with a surface normal, which is what curves the terminator", () => {
    /* The terminator across a sphere is an ellipse, not a straight edge. A
       half-plane cut is the difference between a moon and a pac-man, and it is
       the mistake that looks fine at exactly two phases out of the month. */
    expect(FRAGMENT_SHADER).toMatch(/float w = sqrt\(max\(0\.0, 1\.0 - u \* u - v \* v\)\)/);
    expect(FRAGMENT_SHADER).toMatch(/u \* sin\(theta\) \+ w \* cos\(theta\)/);
  });

  it("points the lit side at the sun that is actually on screen", () => {
    // Both bodies are in the same frame, and the one thing anyone will check is
    // whether the crescent faces the sun they can see.
    expect(FRAGMENT_SHADER).toMatch(/vec3 toSun = uSunDisplayDir - uMoonDisplayDir \* dot\(/);
  });

  it("keeps the unlit half opaque", () => {
    /* Earthshine makes it faintly visible, but even where it is invisible the
       far side of the moon still occludes the stars behind it. Alpha comes from
       the disc, never from how much of it is lit. */
    expect(FRAGMENT_SHADER).toMatch(/bodyAlpha = max\(bodyAlpha, disc \* notBlocked \* uMoonVisible\)/);
    expect(FRAGMENT_SHADER).toMatch(/earthshine/);
  });
});
