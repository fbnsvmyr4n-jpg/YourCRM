import { describe, expect, it } from "vitest";
import {
  bearingDelta,
  facingBearing,
  HORIZONTAL_FOV_DEG,
  limbY,
  project,
  projectBodies,
} from "../src/lib/environment/projection";
import { moonSnapshot, solarSnapshot } from "../src/lib/solar/suncalc";
import type { Coordinates } from "../src/lib/solar/types";

/**
 * Putting the sun where it belongs, over a curved horizon.
 *
 * The canonical composition looks down at the Earth's limb with the sun and
 * moon behind it. The limb is an ARC, so "on the horizon" is not one screen
 * row — a body at the frame's edge sits lower than one at the centre, and
 * mapping altitude to a flat line makes the sun float above the planet's
 * shoulder at the edges and sink into it in the middle.
 */

const place = (latitude: number, longitude: number): Coordinates => ({
  latitude,
  longitude,
  source: "gps",
});

const CAPE_TOWN = place(-33.9, 18.4);
const LONDON = place(51.5, -0.1);
const TROMSO = place(69.7, 19.0);

describe("the limb is a curve, not a line", () => {
  it("is highest in the middle and falls away to both edges", () => {
    // Smaller y is higher on screen.
    expect(limbY(0.5)).toBeLessThan(limbY(0.2));
    expect(limbY(0.5)).toBeLessThan(limbY(0.8));
  });

  it("is symmetrical about the centre", () => {
    expect(limbY(0.2)).toBeCloseTo(limbY(0.8), 10);
    expect(limbY(0)).toBeCloseTo(limbY(1), 10);
  });

  it("stays a real number well outside the frame", () => {
    // A body off-screen is an ordinary situation, and the square root inside
    // this function is where an unguarded version returns NaN — which then
    // travels intact into a CSS custom property.
    for (const x of [-5, -1, 1.5, 12]) {
      expect(Number.isFinite(limbY(x)), `limbY(${x}) is not finite`).toBe(true);
    }
  });
});

describe("bearings wrap without the sun leaping the frame", () => {
  it("takes the short way round north", () => {
    /**
     * The classic discontinuity in anything driven by a compass. Azimuth rolls
     * 359 → 0, and a naive subtraction reports a 359° difference where the true
     * one is 1° — which throws the sun the full width of the frame in one tick.
     */
    expect(bearingDelta(1, 359)).toBeCloseTo(2, 6);
    expect(bearingDelta(359, 1)).toBeCloseTo(-2, 6);
    expect(bearingDelta(0, 0)).toBe(0);
    expect(bearingDelta(90, 0)).toBeCloseTo(90, 6);
    expect(bearingDelta(270, 0)).toBeCloseTo(-90, 6);
  });

  it("never reports more than half a turn", () => {
    for (let bearing = 0; bearing < 360; bearing += 3) {
      for (const facing of [0, 45, 180, 270, 359]) {
        const delta = bearingDelta(bearing, facing);
        expect(Math.abs(delta)).toBeLessThanOrEqual(180.000001);
      }
    }
  });
});

describe("a body sits on the limb when its altitude is zero", () => {
  it("lands exactly on the curve, wherever it is horizontally", () => {
    // The property the whole projection exists for. Not "near the bottom of the
    // frame" — on the arc, at whatever x the azimuth put it.
    for (const bearing of [0, 40, 90, 140, 220, 300]) {
      const point = project(0, bearing, 0);
      expect(point.y, `bearing ${bearing} did not sit on the limb`).toBeCloseTo(limbY(point.x), 10);
    }
  });

  it("rises above the limb as altitude increases", () => {
    const horizon = project(0, 0, 0);
    const low = project(10, 0, 0);
    const high = project(45, 0, 0);
    expect(low.y).toBeLessThan(horizon.y);
    expect(high.y).toBeLessThan(low.y);
  });

  it("sets gradually, across the width of its own disc", () => {
    /**
     * Not a switch. The sun is half a degree wide and takes two or three minutes
     * to cross the horizon, so it is genuinely half-set for a while — and a
     * boolean would pop it out of existence in a single frame, at the most
     * watched moment of the entire cycle.
     */
    expect(project(5, 0, 0).visible).toBe(1);
    expect(project(0, 0, 0).visible).toBeCloseTo(0.5, 6);
    expect(project(-5, 0, 0).visible).toBe(0);

    const halfSet = project(-0.1, 0, 0).visible;
    expect(halfSet).toBeGreaterThan(0);
    expect(halfSet).toBeLessThan(0.5);
  });

  it("fades its glow after it has set instead of switching it off", () => {
    // Most of what makes a sunset read as a sunset happens after the disc has
    // gone. A boolean alone would take the glow with it.
    expect(project(0, 0, 0).belowHorizon).toBe(0);
    expect(project(-3, 0, 0).belowHorizon).toBeGreaterThan(0);
    expect(project(-3, 0, 0).belowHorizon).toBeLessThan(1);
    expect(project(-20, 0, 0).belowHorizon).toBe(1);
  });
});

describe("the camera faces the day", () => {
  it("looks north from the south and south from the north", () => {
    /**
     * Read from the sky rather than from a hemisphere test, so the equator —
     * where the noon sun crosses from one side to the other across the year —
     * is correct without being a special case.
     */
    const capeTown = facingBearing(solarSnapshot(new Date("2026-08-24T12:00:00Z"), CAPE_TOWN));
    const london = facingBearing(solarSnapshot(new Date("2026-08-24T12:00:00Z"), LONDON));

    expect(Math.min(capeTown, 360 - capeTown)).toBeLessThan(2);
    expect(london).toBeGreaterThan(178);
    expect(london).toBeLessThan(182);
  });

  it("keeps the sun in frame for the daylight hours", () => {
    /**
     * The requirement §12 states as "prevent the sun from leaving the intended
     * cinematic frame". A realistic 70° lens would hold it for about three hours
     * of a twelve-hour day and leave the composition empty for the rest.
     */
    const outside: string[] = [];
    for (let minute = 0; minute < 1440; minute += 10) {
      const when = new Date(Date.UTC(2026, 7, 24, 0, minute));
      const sun = solarSnapshot(when, CAPE_TOWN);
      if (sun.altitudeDeg <= 0) continue; // below the limb; being off-frame is fine
      const { sun: point } = projectBodies(sun, moonSnapshot(when, CAPE_TOWN));
      if (point.x < 0 || point.x > 1) {
        outside.push(`${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, "0")}`);
      }
    }
    expect(outside, "the sun left the frame while it was up").toEqual([]);
  });

  it("moves the sun across the frame over the day rather than parking it", () => {
    // A camera that tracked the sun exactly would be correct and dead. The
    // whole point is that it visibly travels.
    const positions = [6, 9, 12, 15, 18].map((hour) => {
      const when = new Date(Date.UTC(2026, 7, 24, hour - 2)); // Cape Town local
      const sun = solarSnapshot(when, CAPE_TOWN);
      return projectBodies(sun, moonSnapshot(when, CAPE_TOWN)).sun.x;
    });

    /**
     * Right to left, not left to right — and that is correct rather than a sign
     * error. Facing north from the southern hemisphere, the sun rises on your
     * RIGHT (in the east) and sets on your left. My first version of this test
     * asserted the northern-hemisphere direction and went red, which is the
     * test doing its job on the person who wrote it.
     */
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i], "the sun doubled back").toBeLessThan(positions[i - 1]);
    }
    expect(positions[0] - positions.at(-1)!).toBeGreaterThan(0.3);
  });
});

describe("nothing jumps, anywhere, ever", () => {
  const sweep = (where: Coordinates, date: [number, number, number], label: string) => {
    const jumps: string[] = [];
    let previous: { x: number; y: number } | null = null;

    for (let minute = 0; minute < 1440; minute++) {
      const when = new Date(Date.UTC(date[0], date[1], date[2], 0, minute));
      const { sun } = projectBodies(solarSnapshot(when, where), moonSnapshot(when, where));

      /**
       * Only while the body is in the frame, or just outside it.
       *
       * The one discontinuity this projection genuinely has is the antipode of
       * the camera — directly behind the viewer, where left and right are the
       * same place. Asking for smoothness across it would be asking the geometry
       * to lie. It is also permanently off-screen: see `bearingDelta`.
       *
       * The first version of this filter used ALTITUDE instead, on the reasoning
       * that the sun crosses the antipode in the middle of the night. That is
       * true at Cape Town and false at Tromsø, where the midnight sun circles
       * the whole compass without setting — and this sweep went red and said so.
       * Position, not altitude, is what decides whether a jump can be seen.
       */
      const margin = 0.15;
      if (sun.x < -margin || sun.x > 1 + margin) {
        previous = null;
        continue;
      }

      if (previous) {
        // A minute of real time moves the sun a quarter of a degree. Against a
        // 220° frame that is about a thousandth of the width; 0.05 is generous
        // and still catches a wrap, which would be a jump of order 1.
        const dx = Math.abs(sun.x - previous.x);
        const dy = Math.abs(sun.y - previous.y);
        if (dx > 0.05 || dy > 0.05) {
          jumps.push(`${label}: minute ${minute} moved (${dx.toFixed(3)}, ${dy.toFixed(3)})`);
        }
      }
      previous = { x: sun.x, y: sun.y };
    }
    return jumps;
  };

  it("crosses midnight without the sun leaping the frame", () => {
    expect(sweep(CAPE_TOWN, [2026, 7, 24], "Cape Town")).toEqual([]);
  });

  it("holds through an equinox and both solstices", () => {
    expect(sweep(CAPE_TOWN, [2026, 2, 20], "equinox")).toEqual([]);
    expect(sweep(CAPE_TOWN, [2026, 11, 21], "December")).toEqual([]);
    expect(sweep(CAPE_TOWN, [2026, 5, 21], "June")).toEqual([]);
  });

  it("holds through a polar day, where the sun circles the whole compass", () => {
    /**
     * The hardest case for a bearing-driven projection. Inside the Arctic Circle
     * in June the sun goes right round the horizon without setting, so its
     * azimuth passes through every value including the roll-over at north — the
     * exact moment a naive subtraction throws it across the frame.
     */
    expect(sweep(TROMSO, [2026, 5, 21], "Tromsø midnight sun")).toEqual([]);
  });

  it("produces a finite point at every latitude and hour", () => {
    const broken: string[] = [];
    for (let lat = -90; lat <= 90; lat += 15) {
      for (let hour = 0; hour < 24; hour += 2) {
        const when = new Date(Date.UTC(2026, 5, 21, hour));
        const where = place(lat, 0);
        const { sun, moon } = projectBodies(solarSnapshot(when, where), moonSnapshot(when, where));
        for (const [name, point] of [["sun", sun], ["moon", moon]] as const) {
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            broken.push(`${name} at lat ${lat}, ${hour}h`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("the moon shares the camera", () => {
  it("sits opposite the sun when it is full", () => {
    /**
     * Not arranged — simply true, and it falls out of using one projection for
     * both. A full moon rises as the sun sets and stands across the sky from it,
     * so it appears at the far side of the frame on its own.
     */
    let found = false;
    for (let day = 1; day <= 30 && !found; day++) {
      for (let hour = 0; hour < 24 && !found; hour++) {
        const when = new Date(Date.UTC(2026, 7, day, hour));
        const sun = solarSnapshot(when, CAPE_TOWN);
        const moon = moonSnapshot(when, CAPE_TOWN);
        if (moon.illuminatedFraction < 0.97 || moon.altitudeDeg < 10 || sun.altitudeDeg > -5) continue;

        const { sun: sunPoint, moon: moonPoint } = projectBodies(sun, moon);
        found = true;
        // The sun is below the limb and far from the moon's side of the frame.
        expect(sunPoint.visible).toBe(0);
        expect(Math.abs(moonPoint.x - sunPoint.x)).toBeGreaterThan(0.2);
      }
    }
    expect(found, "no full moon rose on a night in August 2026").toBe(true);
  });

  it("is drawable only when it is above the limb", () => {
    const when = new Date(Date.UTC(2026, 7, 24, 12));
    const { moon } = projectBodies(
      solarSnapshot(when, CAPE_TOWN),
      { altitudeDeg: -30, azimuthDeg: 100, illuminatedFraction: 1 }
    );
    expect(moon.visible).toBe(0);
  });
});

describe("the frame is wide enough to be worth watching", () => {
  it("shows more than a realistic lens would", () => {
    // Stated as a test because it is a deliberate departure from realism, and
    // somebody "correcting" it to 70° would silently empty the composition.
    expect(HORIZONTAL_FOV_DEG).toBeGreaterThan(180);
  });

  it("keeps the wrap point off-screen, whatever the field of view", () => {
    /**
     * The property that makes the antipode discontinuity unobservable, asserted
     * rather than assumed. Any field of view under 360° places its own antipode
     * outside the frame — so widening this to 300° for a different composition
     * stays safe, and a change to 360° or beyond would fail here rather than
     * shipping a sun that teleports across a polar sky.
     */
    const atAntipode = project(10, 180, 0);
    expect(atAntipode.x < 0 || atAntipode.x > 1, "the wrap point is inside the frame").toBe(true);
    expect(HORIZONTAL_FOV_DEG).toBeLessThan(360);
  });
});
