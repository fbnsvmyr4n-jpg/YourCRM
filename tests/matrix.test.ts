import { describe, expect, it, vi } from "vitest";
import { EnvironmentClock } from "../src/lib/environment/clock";
import { approach } from "../src/lib/environment/curves";
import { environmentFor, lightValues } from "../src/lib/environment/model";
import { scenePalette, contrastRatio } from "../src/lib/environment/palette";
import { projectBodies } from "../src/lib/environment/projection";
import { resolveLocation } from "../src/lib/solar/location";
import { moonSnapshot, solarSnapshot } from "../src/lib/solar/suncalc";
import type { Coordinates } from "../src/lib/solar/types";

/**
 * §20's testing matrix, run rather than described.
 *
 * The specification lists eighteen conditions and asks for them to be checked.
 * Most are checked in the suites that own them — the seams in `environment`,
 * the ladder in `location`, the projection's continuity in `projection`. What
 * this file adds is the cases that fall between those suites, and the ones §20
 * names that nothing else was exercising: a clock that changes mid-session, a
 * network that dies after load, and every listed place at once.
 */

const place = (latitude: number, longitude: number, name: string) =>
  ({ latitude, longitude, source: "gps" as const, name });

/** §20's geographic list, in full. */
const PLACES = [
  place(-33.9, 18.4, "Cape Town"),
  place(0, 0, "equator"),
  place(51.5, -0.1, "London"),
  place(69.7, 19.0, "Tromsø (Arctic)"),
  place(-54.8, -68.3, "Ushuaia"),
  place(78.2, 15.6, "Svalbard"),
  place(-90, 0, "South Pole"),
  place(90, 0, "North Pole"),
];

/** Summer, winter, and both equinoxes. */
const DATES: [string, number, number][] = [
  ["midsummer (N)", 5, 21],
  ["midwinter (N)", 11, 21],
  ["March equinox", 2, 20],
  ["September equinox", 8, 22],
];

const stateAt = (when: Date, where: Coordinates) =>
  environmentFor(solarSnapshot(when, where), moonSnapshot(when, where));

describe("every place, every season", () => {
  it("produces a sane environment at all of them", () => {
    /**
     * The whole matrix in one sweep. Not a formality: the poles are where
     * `solarNoonAzimuthDeg` has no meaningful direction, the equinoxes are
     * where the equator's sun passes exactly overhead, and Svalbard is where
     * neither sunrise nor sunset exists for months.
     */
    const problems: string[] = [];

    for (const where of PLACES) {
      for (const [season, month, day] of DATES) {
        for (let hour = 0; hour < 24; hour += 2) {
          const when = new Date(Date.UTC(2026, month, day, hour));
          const state = stateAt(when, where);
          const at = `${where.name}, ${season}, ${String(hour).padStart(2, "0")}h`;

          for (const [name, value] of Object.entries(lightValues(state))) {
            if (!Number.isFinite(value) || value < 0 || value > 1) {
              problems.push(`${at}: ${name} = ${value}`);
            }
          }

          if (!state.phase) problems.push(`${at}: no phase`);

          const { sun, moon } = projectBodies(
            solarSnapshot(when, where),
            moonSnapshot(when, where)
          );
          for (const [name, point] of [["sun", sun], ["moon", moon]] as const) {
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
              problems.push(`${at}: ${name} projected to a broken point`);
            }
          }

          const palette = scenePalette(state);
          if (contrastRatio(palette.cardMuted, palette.cardSurface) < 4.5) {
            problems.push(`${at}: text below AA`);
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it("finds a polar day and a polar night in the list, not just ordinary places", () => {
    /**
     * The counter-check. A matrix of eight comfortable mid-latitudes would pass
     * everything above and prove nothing about the cases the specification
     * actually worries about.
     */
    const polar = PLACES.filter((where) =>
      DATES.some(([, month, day]) =>
        solarSnapshot(new Date(Date.UTC(2026, month, day, 12)), where).polar
      )
    );
    expect(polar.map((p) => p.name).length).toBeGreaterThanOrEqual(3);
  });

  it("finds a sun directly overhead somewhere in it", () => {
    // The equator at an equinox: altitude ~90°, where a projection dividing by
    // a cosine would go to infinity.
    const noon = solarSnapshot(new Date(Date.UTC(2026, 2, 20, 12)), PLACES[1]);
    expect(noon.altitudeDeg).toBeGreaterThan(85);
  });
});

describe("the clock changes underneath us", () => {
  /**
   * §20 lists "system clock/date change" and nothing was exercising it. Three
   * real ways it happens: an NTP correction, the end of daylight saving, and
   * somebody simply setting their clock.
   */
  const harness = (startAt: number) => {
    let wall = startAt;
    const published: { skyBrightness: number }[] = [];
    const clock = new EnvironmentClock({
      location: { latitude: -33.9, longitude: 18.4, source: "gps" },
      publish: (state) => published.push({ skyBrightness: state.skyBrightness }),
      source: { now: () => wall, requestFrame: () => 1, cancelFrame: () => {} },
    });
    return {
      clock,
      published,
      set: (to: number) => {
        wall = to;
      },
      step: (ms: number) => {
        wall += ms;
        clock.tick();
      },
    };
  };

  it("follows the clock forward across a date boundary", () => {
    // The cached solar events are keyed on the calendar day, so a rollover has
    // to invalidate them or the scene keeps yesterday's sunset forever.
    const h = harness(Date.UTC(2026, 2, 20, 23, 30));
    h.clock.start();
    const before = h.clock.solar().sunset;

    h.set(Date.UTC(2026, 2, 21, 0, 30));
    h.clock.tick();

    expect(h.clock.solar().sunset).not.toBe(before);
  });

  it("does not jump when the clock steps backwards", () => {
    /**
     * An NTP correction or the end of daylight saving moves the clock back, and
     * the elapsed time for that tick is zero or negative. `approach` used to
     * answer that with the TARGET — a jump dressed up as an easing, at the one
     * moment nothing should visibly move.
     */
    const eased = approach(0.2, 0.9, 500, 0);
    expect(eased, "a backward clock step snapped the scene").toBe(0.2);
    expect(approach(0.2, 0.9, 500, -1000)).toBe(0.2);
  });

  it("reconciles rather than replaying when the clock leaps forward", () => {
    // Waking from sleep. The state must be right for NOW, not animated through
    // the hours that were missed.
    const h = harness(Date.UTC(2026, 2, 20, 22, 0));
    h.clock.start();
    h.set(Date.UTC(2026, 2, 21, 10, 0));
    h.clock.snap();
    expect(h.clock.read()).toEqual(h.clock.target());
  });

  it("survives a clock set to a nonsense date", () => {
    // A device with a dead battery boots at the epoch. It should render
    // something coherent rather than breaking.
    const h = harness(0);
    h.clock.start();
    const state = h.clock.read();
    expect(Number.isFinite(state.skyBrightness)).toBe(true);
    expect(state.phase).toBeTruthy();
  });
});

describe("the network dies after the page loads", () => {
  it("needs no network at all once location is settled", async () => {
    /**
     * §20's "network unavailable after initial load". The solar engine is
     * local by design — §27's whole reason for using a library instead of an
     * API — so this should be true structurally. Asserted by counting calls:
     * after the ladder settles, a fetch must never be made again.
     */
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const where = await resolveLocation({
      geolocation: null,
      fetcher: fetcher as unknown as typeof fetch,
    });
    const callsAfterResolving = fetcher.mock.calls.length;

    // Now run a whole simulated day through the model.
    for (let minute = 0; minute < 1440; minute += 10) {
      stateAt(new Date(Date.UTC(2026, 2, 20, 0, minute)), where);
    }

    expect(fetcher.mock.calls.length, "the environment reached for the network").toBe(
      callsAfterResolving
    );
  });

  it("keeps rendering the right sky with no connection whatsoever", () => {
    // Nothing in the render path is async, so "offline" is not a state the
    // scene can be in — but it is worth pinning, because adding a weather
    // lookup later would break it silently. §17 is out of scope for exactly
    // this reason.
    const where: Coordinates = { latitude: -33.9, longitude: 18.4, source: "default" };
    const noon = stateAt(new Date(Date.UTC(2026, 2, 20, 10, 49)), where);
    expect(noon.daylight).toBeGreaterThan(0.9);
    expect(noon.phase).toBe("day");
  });
});

describe("permissions, in every state §20 lists", () => {
  const granted = () => ({
    getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number } }) => void) =>
      ok({ coords: { latitude: 51.5, longitude: -0.1 } }),
  });
  const denied = () => ({
    getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) => fail({ code: 1 }),
  });
  const unavailable = () => ({
    getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) => fail({ code: 2 }),
  });

  const noIp = () => vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;

  it.each([
    ["granted", granted(), "gps"],
    ["denied", denied(), "default"],
    ["position unavailable", unavailable(), "default"],
    ["geolocation absent", null, "default"],
  ])("resolves with permission %s", async (_label, geolocation, expected) => {
    const where = await resolveLocation({ geolocation, fetcher: noIp(), timeoutMs: 40 });
    expect(where.source).toBe(expected);
    // And whatever came back must produce a usable sky.
    const state = stateAt(new Date(Date.UTC(2026, 2, 20, 12)), where);
    expect(Number.isFinite(state.skyBrightness)).toBe(true);
  });
});
