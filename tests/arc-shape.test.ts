import { describe, expect, it } from "vitest";
import { solarSnapshot } from "../src/lib/solar/suncalc";
import { aimBody, LIMB_ALTITUDE_DEG } from "../src/lib/environment/projection";

/**
 * The sun's path across the frame, checked as a SHAPE.
 *
 * Everything else about the aim is checked a point at a time. This is the only
 * test that looks at the whole arc, which is the thing actually being designed
 * — and it is where two earlier attempts failed in a way no single point could
 * have shown: they framed the equinox correctly and threw the sun off the side
 * of the screen for up to ten hours at midsummer, because screen x depends on
 * altitude as well as bearing.
 *
 * The targets come from a sketch over a screenshot: an arc up one edge, across
 * the top, and down the other, with a half-width of about 0.44 and an apex
 * around y = 0.20.
 */

const CAMERA = {
  fovRad: (58 * Math.PI) / 180,
  pitchRad: (-41 * Math.PI) / 180,
  facingDeg: 0,
  aspect: 2194 / 1726,
};

const CAPE_TOWN = { latitude: -33.9, longitude: 18.4, source: "default" } as const;

/** The inverse of the shader's ray, so this measures where it will be drawn. */
function screenOf(d: readonly [number, number, number]) {
  const cp = Math.cos(CAMERA.pitchRad);
  const sp = Math.sin(CAMERA.pitchRad);
  const ry = d[1] * cp + d[2] * sp;
  if (ry <= 0) return null;
  const rz = -d[1] * sp + d[2] * cp;
  const t = Math.tan(CAMERA.fovRad / 2);
  return { x: (d[0] / ry / t / CAMERA.aspect + 1) / 2, y: 1 - (rz / ry / t + 1) / 2 };
}

function arc(month: number, day: number) {
  let minX = 9;
  let maxX = -9;
  let apex = 9;
  let offFrameMinutes = 0;
  let visibleMinutes = 0;

  for (let m = 0; m < 1440; m += 10) {
    /* Through the project's own wrapper rather than raw SunCalc: that file is
       where the library's measured conventions live — it returns DEGREES, and
       azimuth as a compass bearing, neither of which its README says. */
    const sun = solarSnapshot(new Date(Date.UTC(2026, month, day, 0, m)), CAPE_TOWN);
    const aim = aimBody(sun.altitudeDeg, sun.azimuthDeg, CAMERA);
    const altitude = (Math.asin(aim.direction[2]) * 180) / Math.PI;
    if (altitude < LIMB_ALTITUDE_DEG) continue; // behind the planet

    const s = screenOf(aim.direction);
    if (!s || s.y > 1) continue;

    visibleMinutes += 10;
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x);
    apex = Math.min(apex, s.y);
    if (s.x < 0.02 || s.x > 0.98 || s.y < 0) offFrameMinutes += 10;
  }
  return { minX, maxX, apex, offFrameMinutes, visibleMinutes };
}

describe("the sun's arc across the frame", () => {
  it("stays on screen all day, in every season", () => {
    /**
     * The assertion two earlier designs failed. Both scaled azimuth by a
     * constant; both framed the equinox correctly and lost the sun off the side
     * for hundreds of minutes at midsummer, when azimuth swings ±115° rather
     * than ±89°. Bounding an angle does not bound a position.
     */
    for (const [name, month, day] of [
      ["equinox", 2, 20],
      ["midsummer", 11, 21],
      ["midwinter", 5, 21],
    ] as const) {
      const a = arc(month, day);
      expect(a.offFrameMinutes, `${name}: minutes spent off the edge of the frame`).toBe(0);
      expect(a.visibleMinutes, `${name}: the sun should be up for hours`).toBeGreaterThan(240);
    }
  });

  it("sweeps the width the reference asks for", () => {
    // Sketched half-width 0.44 about centre. Ours is symmetric about 0.5.
    const a = arc(2, 20);
    expect(a.maxX - a.minX).toBeGreaterThan(0.7);
    expect(a.minX).toBeLessThan(0.15);
    expect(a.maxX).toBeGreaterThan(0.85);
  });

  it("peaks where the reference peaks, and never leaves the top", () => {
    expect(arc(2, 20).apex).toBeCloseTo(0.2, 1);
    // Midsummer's much higher sun must still stay under the top edge.
    expect(arc(11, 21).apex).toBeGreaterThan(0.0);
  });

  it("puts a body at the horizon exactly on the limb, whatever its bearing", () => {
    /* The composition's premise, and the property that lets azimuth be moved
       artistically at all: the planet's edge is at the same altitude in every
       direction, so nothing horizontal can change WHEN a body crosses it. */
    for (const azimuth of [0, 45, 90, 180, 270, 330]) {
      const aim = aimBody(0, azimuth, CAMERA);
      const altitude = (Math.asin(aim.direction[2]) * 180) / Math.PI;
      expect(altitude, `azimuth ${azimuth}`).toBeCloseTo(LIMB_ALTITUDE_DEG, 3);
    }
  });
});
