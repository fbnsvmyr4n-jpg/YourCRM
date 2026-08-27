import { describe, expect, it } from "vitest";
import { CAMERA_ARC_DEG, cameraAnchor, reframeDirection } from "@/lib/environment/projection";

/**
 * Where the login globe's camera stands.
 *
 * It used to stand directly above the observer, which sounds right and put the
 * observer off the bottom of the screen. Traced against the shader's own
 * numbers — 5,500km up, a 58° frame, pitched -41° — the nearest ground it could
 * see was 19.6° of arc away, so the observer sat 2,174km BELOW the frame.
 *
 * From Cape Town, facing the solar-noon bearing of due north, the visible band
 * began somewhere over Angola. That is the reported "shows Southern Africa but
 * cuts off Cape Town", and it was never an accuracy problem: the place was not
 * on screen at any zoom.
 */

const R_KM = 6371;
/** Great-circle degrees between two points. */
function arcDeg(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const rad = Math.PI / 180;
  const φ1 = a.latitude * rad,
    φ2 = b.latitude * rad;
  const dφ = (b.latitude - a.latitude) * rad;
  const dλ = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / rad;
}

/** Initial bearing from a to b, in degrees. */
function bearingDeg(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const rad = Math.PI / 180;
  const φ1 = a.latitude * rad,
    φ2 = b.latitude * rad;
  const dλ = (b.longitude - a.longitude) * rad;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

const CAPE_TOWN = { latitude: -33.9, longitude: 18.4 };
const LONDON = { latitude: 51.5, longitude: -0.1 };

describe("the camera anchor", () => {
  it("stands exactly the intended arc from the observer", () => {
    /* The whole fix is this distance: too little and the observer is still off
       the bottom, too much and they sit on the limb. */
    for (const where of [CAPE_TOWN, LONDON, { latitude: 0, longitude: 0 }]) {
      for (const facing of [0, 90, 180, 270, 37]) {
        expect(arcDeg(where, cameraAnchor(where, facing))).toBeCloseTo(CAMERA_ARC_DEG, 6);
      }
    }
  });

  it("stands BEHIND the observer, so they land inside the frame", () => {
    /**
     * The direction is the half of this that is easy to get backwards, and
     * getting it backwards is invisible in a still: the globe still shows a
     * plausible place, just 28° the wrong side — 56° of arc from where the
     * user actually is.
     *
     * Cape Town faces due north at solar noon, so the camera belongs to its
     * SOUTH, out over the ocean, looking back across the city.
     */
    const anchor = cameraAnchor(CAPE_TOWN, 0);
    expect(anchor.latitude).toBeLessThan(CAPE_TOWN.latitude);

    /* And from that anchor the observer lies along the facing bearing. */
    expect(bearingDeg(anchor, CAPE_TOWN)).toBeCloseTo(0, 4);
  });

  it("follows the bearing rather than assuming a hemisphere", () => {
    /* London faces due south at solar noon, so its camera belongs to the
       NORTH — the opposite side from Cape Town's. A fix that just subtracted
       latitude would be right in one hemisphere and wrong in the other. */
    const anchor = cameraAnchor(LONDON, 180);
    expect(anchor.latitude).toBeGreaterThan(LONDON.latitude);
    expect(bearingDeg(anchor, LONDON)).toBeCloseTo(180, 4);
  });

  it("keeps longitude readable across the date line", () => {
    /* Left unwrapped, a camera stepping west from Fiji reads as +187°, which
       is most of a world from where it is and samples the map accordingly. */
    const fiji = { latitude: -17.8, longitude: 178.0 };
    const anchor = cameraAnchor(fiji, 270);
    expect(anchor.longitude).toBeGreaterThan(-180);
    expect(anchor.longitude).toBeLessThanOrEqual(180);
    expect(arcDeg(fiji, anchor)).toBeCloseTo(CAMERA_ARC_DEG, 6);
  });

  it("puts the observer inside the band the frame actually shows", () => {
    /**
     * The numbers this exists to satisfy, traced from the shader: the planet
     * occupies arc 19.6° (bottom edge) to 53.0° (limb). Anywhere in between is
     * on screen; 28° is about 78% of the way down, near the middle of the
     * planet rather than balanced on its edge.
     */
    expect(CAMERA_ARC_DEG).toBeGreaterThan(19.6);
    expect(CAMERA_ARC_DEG).toBeLessThan(53.0);
  });
});

describe("re-expressing a direction at the anchor", () => {
  it("leaves a direction alone when the frame does not move", () => {
    const d = reframeDirection([0.3, -0.5, 0.81], CAPE_TOWN, CAPE_TOWN);
    expect(d[0]).toBeCloseTo(0.3, 12);
    expect(d[1]).toBeCloseTo(-0.5, 12);
    expect(d[2]).toBeCloseTo(0.81, 12);
  });

  it("keeps it a unit vector", () => {
    /* It is a rotation between two orthonormal frames, so length is preserved.
       A length change here would silently brighten or dim the whole planet,
       because the shader dots it against surface normals. */
    const sun = [0.42, 0.63, 0.653];
    const out = reframeDirection(sun, CAPE_TOWN, cameraAnchor(CAPE_TOWN, 0));
    const len = Math.hypot(...out);
    expect(len).toBeCloseTo(Math.hypot(...sun), 12);
  });

  it("tilts the sun by the arc the camera moved", () => {
    /**
     * The reason this exists. `uSunDir` is written in the local east/north/up
     * of whatever point the shader's origin sits over, so moving the camera
     * 28° of arc without re-expressing it lights the ground from 28° wrong and
     * slides the terminator across the map — at sunrise, the most visible thing
     * in the frame.
     *
     * A sun directly overhead at the observer must sit 28° off vertical when
     * read from a point 28° of arc away.
     */
    const overhead = [0, 0, 1];
    const anchor = cameraAnchor(CAPE_TOWN, 0);
    const seen = reframeDirection(overhead, CAPE_TOWN, anchor);
    const tiltDeg = (Math.acos(Math.min(1, seen[2])) * 180) / Math.PI;
    expect(tiltDeg).toBeCloseTo(CAMERA_ARC_DEG, 4);

    /* And tilted toward the observer, who is due north of the anchor. */
    expect(seen[1]).toBeGreaterThan(0);
    expect(Math.abs(seen[0])).toBeLessThan(1e-9);
  });
});
