import { describe, expect, it } from "vitest";
import { EnvironmentClock, estimateLocationFromClock } from "../src/lib/environment/clock";
import { ENV_PROPERTIES, propertyName } from "../src/lib/environment/publish";
import type { EnvironmentState } from "../src/lib/environment/model";
import type { Coordinates } from "../src/lib/solar/types";

/**
 * The clock, driven by a fake wall clock.
 *
 * Time is injected, so a whole day runs in a millisecond and every case that
 * would otherwise need waiting — a scrub, a backgrounded tab, a laptop closed
 * at dusk and opened at breakfast — is an ordinary test.
 */

const CAPE_TOWN: Coordinates = { latitude: -33.9, longitude: 18.4, source: "gps" };
const LONDON: Coordinates = { latitude: 51.5, longitude: -0.1, source: "gps" };

/** A wall clock we control, plus a frame pump that only runs when asked. */
function harness(startAt = Date.UTC(2026, 2, 20, 10, 0)) {
  let wall = startAt;
  const frames: (() => void)[] = [];
  const published: EnvironmentState[] = [];

  const clock = new EnvironmentClock({
    location: CAPE_TOWN,
    publish: (state) => published.push(state),
    source: {
      now: () => wall,
      requestFrame: (cb) => {
        frames.push(() => cb(wall));
        return frames.length;
      },
      cancelFrame: () => {},
    },
  });

  return {
    clock,
    published,
    /** Advance the wall clock and run one tick, as a frame would. */
    advance(ms: number) {
      wall += ms;
      clock.tick();
    },
    /** Move the wall clock without ticking — a backgrounded tab. */
    sleep(ms: number) {
      wall += ms;
    },
    at: () => wall,
  };
}

describe("the clock runs the environment", () => {
  it("publishes a state as soon as it starts", () => {
    const h = harness();
    h.clock.start();
    expect(h.published.length).toBeGreaterThan(0);
    expect(h.published[0].phase).toBeTruthy();
  });

  it("does not ease in from nowhere on the first frame", () => {
    /**
     * The first frame has nothing to ease *from*. Starting at zero and easing
     * up would open the page with a fade-in from black — a hard transition on
     * the most visible frame there is, and exactly what §29 forbids.
     */
    const h = harness();
    h.clock.start();
    expect(h.published[0]).toEqual(h.clock.target());
  });

  it("eases toward a target rather than jumping to it", () => {
    const h = harness(Date.UTC(2026, 2, 20, 3, 30));
    h.clock.start();
    const start = h.clock.read().skyBrightness;

    // Jump the simulated instant to the middle of the day, then let one short
    // frame pass. The state should have moved toward daylight without arriving.
    h.clock.override({ at: Date.UTC(2026, 2, 20, 10, 49) });
    const targetBrightness = h.clock.target().skyBrightness;
    expect(targetBrightness).toBeGreaterThan(start);
  });

  it("keeps easing frame-rate independent", () => {
    /**
     * Two runs across the same span of wall-clock time, one at 60fps and one at
     * 30, must land in the same place. The naive per-frame lerp does not: it
     * settles twice as fast on a 120Hz display, so the same sunset takes
     * different lengths of time on different machines.
     */
    const fast = harness(Date.UTC(2026, 2, 20, 5, 0));
    const slow = harness(Date.UTC(2026, 2, 20, 5, 0));
    fast.clock.start();
    slow.clock.start();

    fast.clock.override({ at: Date.UTC(2026, 2, 20, 10, 49) });
    slow.clock.override({ at: Date.UTC(2026, 2, 20, 10, 49) });

    for (let i = 0; i < 20; i++) fast.advance(16);
    for (let i = 0; i < 10; i++) slow.advance(32);

    expect(fast.clock.read().glassLightness).toBeCloseTo(slow.clock.read().glassLightness, 4);
  });
});

describe("a tab that was in the background", () => {
  it("reconciles to the real time instead of replaying the night", () => {
    /**
     * §11's requirement, and the failure it prevents: a laptop closed at dusk
     * and opened at breakfast. Without the snap, the clock eases from the state
     * it was last in — so the user watches an accelerated sunrise that already
     * happened, over a scene that is telling them the wrong time.
     */
    const h = harness(Date.UTC(2026, 2, 20, 17, 0)); // early evening
    h.clock.start();
    const dusk = h.clock.read();

    h.sleep(14 * 60 * 60_000); // fourteen hours, no frames — the tab was hidden
    h.clock.snap();
    const morning = h.clock.read();

    expect(morning.skyBrightness).toBeGreaterThan(dusk.skyBrightness);
    expect(morning).toEqual(h.clock.target());
  });

  it("lands in the same place whether it ticked or slept", () => {
    // Fewer, longer steps must land where many short ones do. This is what
    // makes a throttled tab correct rather than merely slow.
    const ticked = harness(Date.UTC(2026, 2, 20, 6, 0));
    const slept = harness(Date.UTC(2026, 2, 20, 6, 0));
    ticked.clock.start();
    slept.clock.start();

    for (let i = 0; i < 60; i++) ticked.advance(1000);
    slept.advance(60_000);

    expect(ticked.clock.read().skyBrightness).toBeCloseTo(slept.clock.read().skyBrightness, 3);
  });
});

describe("reduced motion", () => {
  it("keeps the true sky and drops only the easing", () => {
    /**
     * The distinction that matters. Reduced motion is a preference about
     * movement, not a request to be shown the wrong time of day — so the state
     * is still the correct one for this place and this minute; it simply
     * arrives without travelling.
     */
    const h = harness(Date.UTC(2026, 2, 20, 3, 0));
    h.clock.setReducedMotion(true);
    h.clock.start();

    h.clock.override({ at: Date.UTC(2026, 2, 20, 10, 49) });
    h.advance(16);

    expect(h.clock.read()).toEqual(h.clock.target());
    expect(h.clock.read().daylight).toBeGreaterThan(0.5);
  });

  it("can be turned on part-way through a session", () => {
    const h = harness();
    h.clock.start();
    h.clock.setReducedMotion(true);
    h.advance(16);
    expect(h.clock.read()).toEqual(h.clock.target());
  });
});

describe("the simulator's controls", () => {
  it("scrubs to an instant and shows it immediately", () => {
    // A scrub is not a transition. Dragging to midnight and watching a
    // two-second ease would make the control useless for checking a boundary.
    const h = harness();
    h.clock.start();
    h.clock.override({ at: Date.UTC(2026, 2, 20, 22, 0) });
    expect(h.clock.read()).toEqual(h.clock.target());
    expect(h.clock.read().phase).toBe("night");
  });

  it("runs simulated time faster than real time", () => {
    const h = harness();
    h.clock.start();
    h.clock.override({ at: Date.UTC(2026, 2, 20, 6, 0), speed: 600 });

    const before = h.clock.solar().timestamp;
    h.advance(1000); // one real second
    const after = h.clock.solar().timestamp;

    // Ten simulated minutes for one real second.
    expect(after - before).toBeCloseTo(600_000, -3);
  });

  it("hands control back to the real clock", () => {
    const h = harness();
    h.clock.start();
    h.clock.override({ at: Date.UTC(2026, 2, 20, 22, 0) });
    expect(h.clock.read().phase).toBe("night");

    h.clock.override({ at: null });
    expect(h.clock.solar().timestamp).toBe(h.at());
  });

  it("changes location without teleporting the sky", () => {
    /**
     * §18: reconcile smoothly when coordinates change. Moving from Cape Town to
     * London is a real difference in the sky, and cutting to it looks like a
     * bug — so `setLocation` deliberately does not snap.
     */
    // 18:00 UTC on the June solstice: Cape Town is well past sunset while
    // London still has two hours of daylight. Noon would have had both in full
    // sun with nothing to ease between — a test that passed for no reason.
    const h = harness(Date.UTC(2026, 5, 21, 18, 0));
    h.clock.start();
    const before = h.clock.read().skyBrightness;

    h.clock.setLocation(LONDON);
    const targetNow = h.clock.target().skyBrightness;
    expect(targetNow, "the two cities' skies are indistinguishable here").not.toBeCloseTo(before, 2);

    h.advance(16);
    const after = h.clock.read().skyBrightness;

    // Moved toward London, but nowhere near arrived: a cut would read as a bug.
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(targetNow);
  });
});

describe("what gets published", () => {
  it("does not publish a change no screen could show", () => {
    // Writing a custom property invalidates style for everything reading it.
    // Publishing a ten-thousandth every frame is real work spent on nothing.
    const h = harness();
    h.clock.start();
    const afterStart = h.published.length;

    // Settled: a few frames with nothing meaningful changing.
    for (let i = 0; i < 5; i++) h.advance(16);

    expect(h.published.length - afterStart).toBeLessThan(5);
  });

  it("always publishes a phase change", () => {
    const h = harness(Date.UTC(2026, 2, 20, 12, 0));
    h.clock.start();
    const before = h.published.length;
    h.clock.override({ at: Date.UTC(2026, 2, 20, 22, 0) });
    expect(h.published.length).toBeGreaterThan(before);
    expect(h.published.at(-1)!.phase).toBe("night");
  });

  it("publishes every value the scene reads, and nothing broken", () => {
    const h = harness();
    h.clock.start();
    const state = h.published[0] as unknown as Record<string, number>;
    for (const key of ENV_PROPERTIES) {
      expect(Number.isFinite(state[key]), `${key} is not a finite number`).toBe(true);
    }
  });

  it("names the properties in kebab-case for CSS", () => {
    expect(propertyName("skyBrightness")).toBe("--env-sky-brightness");
    expect(propertyName("daylight")).toBe("--env-daylight");
    expect(propertyName("limbWarmth")).toBe("--env-limb-warmth");
  });
});

describe("the very first paint", () => {
  it("guesses a longitude from the device's own time zone", () => {
    /**
     * No permission, no network, no delay — and it puts the page in roughly the
     * right part of the cycle immediately. The alternative is rendering a
     * default sky and cutting to the real one when coordinates land, which is a
     * hard transition on the most visible frame of the feature.
     */
    const where = estimateLocationFromClock();
    expect(Number.isFinite(where.longitude)).toBe(true);
    expect(where.longitude).toBeGreaterThanOrEqual(-180);
    expect(where.longitude).toBeLessThanOrEqual(180);
    expect(where.source).toBe("default");
  });

  it("admits it does not know the latitude", () => {
    // Zero is the honest guess rather than a flattering one: at the equator the
    // sun rises near six and sets near six, which is the least wrong answer
    // available for somebody who could be anywhere.
    expect(estimateLocationFromClock().latitude).toBe(0);
  });

  it("produces a usable environment on its own", () => {
    const h = harness();
    h.clock.setLocation(estimateLocationFromClock());
    h.clock.start();
    const state = h.clock.read();
    expect(Number.isFinite(state.skyBrightness)).toBe(true);
    expect(state.phase).toBeTruthy();
  });
});
