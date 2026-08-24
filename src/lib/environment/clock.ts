import { approach } from "./curves";
import { environmentFor, type EnvironmentState } from "./model";
import { moonSnapshot, solarSnapshot } from "../solar/suncalc";
import type { Coordinates, SolarSnapshot } from "../solar/types";

/**
 * One clock for the whole environment.
 *
 * §11's requirement, and the reason it matters: a scene lit by six independent
 * intervals is a scene whose parts disagree about what time it is. Everything
 * here advances from a single tick, so the sky, the water and the card are
 * always describing the same instant even when they are easing toward it at
 * different speeds.
 *
 * The engine is deliberately ignorant of the DOM. It takes a `publish` callback
 * and a couple of injectable timers, which is what lets a whole simulated day
 * be run in a test — at any speed, in any order — without a browser and without
 * waiting for one real second to pass.
 */

/**
 * How long each value takes to close half the distance to its target.
 *
 * Different per variable, which §10 asks for explicitly and which is most of
 * what makes the scene feel like a place rather than a slider. The sky answers
 * light quickly because air does; the card answers slowly because glass does.
 * A card that tracked the sky exactly would shimmer during a fast sunset —
 * technically correct, and readable as a bug.
 */
const HALF_LIFE_MS: Partial<Record<keyof EnvironmentState, number>> = {
  skyBrightness: 400,
  daylight: 400,
  warmth: 700,
  haze: 900,
  limbIntensity: 500,
  limbWarmth: 700,
  sunIntensity: 350,
  moonlight: 1200,
  reflection: 800,
  starVisibility: 1400,
  cityLights: 1600,
  glassLightness: 2200,
  glassOpacity: 2200,
  textScrim: 1800,
};

/** Anything without its own entry eases at this rate. */
const DEFAULT_HALF_LIFE_MS = 600;

/**
 * Frame budget, and how a device is judged too slow for the full scene.
 *
 * §23 ends with "measure actual performance instead of assuming it is fast",
 * and this is the one honest way to do that: the clock already times every
 * frame, so it can watch what the scene actually costs on the machine it is
 * running on rather than guessing from a core count. A phone with eight cores
 * behind a thermal throttle is slow; a five-year-old laptop plugged in may not
 * be. Only the frames know.
 *
 * 28ms is about 36fps — comfortably below 60 without tripping on the odd
 * stutter, since the decision is made on a MEDIAN.
 */
const FRAME_BUDGET_MS = 28;

/** How many frames to watch before judging. Roughly a second at 60fps. */
const FRAME_SAMPLE = 48;

/**
 * Intervals longer than this are not slowness.
 *
 * A backgrounded tab produces gaps of seconds, and a machine waking from sleep
 * produces gaps of hours. Counting those as dropped frames would put every tab
 * anyone left open into low-power mode the moment they came back to it — a
 * degraded scene as the reward for returning.
 */
const THROTTLE_FLOOR_MS = 200;

/**
 * How far a value must move before it is worth publishing.
 *
 * Writing a custom property invalidates style for the subtree that reads it, so
 * publishing a change of one ten-thousandth every frame costs real work to
 * express something no screen can show. This is the difference between a
 * cheap animation and a hot one.
 */
const EPSILON = 0.002;

export type ClockSource = {
  /** Wall clock. Injectable so a test can run a year in a millisecond. */
  now: () => number;
  requestFrame: (callback: (timestamp: number) => void) => number;
  cancelFrame: (handle: number) => void;
};

export type ClockOptions = {
  location: Coordinates;
  publish: (state: EnvironmentState) => void;
  source?: Partial<ClockSource>;
  /**
   * Motion off, information intact.
   *
   * Reduced motion means the state jumps straight to its target rather than
   * easing — it does NOT mean a static fallback showing the wrong time of day.
   * Somebody with vestibular sensitivity is expressing a preference about
   * movement, not asking to be misinformed about the sky.
   */
  reducedMotion?: boolean;

  /** Called once if the device turns out not to keep up. */
  onLowPower?: (low: boolean) => void;
};

/** What the simulator can override. Absent in production. */
export type ClockOverride = {
  /** Pretend it is this instant. Null hands control back to the real clock. */
  at?: number | null;
  /** How fast simulated time runs. 1 is real time; 600 is a day in 2.4 minutes. */
  speed?: number;
  location?: Coordinates;
};

const defaultSource = (): ClockSource => ({
  now: () => Date.now(),
  requestFrame:
    typeof requestAnimationFrame !== "undefined"
      ? (cb) => requestAnimationFrame(cb)
      : (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
  cancelFrame:
    typeof cancelAnimationFrame !== "undefined"
      ? (h) => cancelAnimationFrame(h)
      : (h) => clearTimeout(h),
});

/**
 * Today's solar events, remembered.
 *
 * §11 requires the expensive work to stay out of the animation loop. Event
 * calculation is the expensive part; the sun's *position* is cheap and is
 * recomputed every tick. Keyed on the calendar day and the rounded coordinates,
 * so it recomputes when the date rolls over or the user moves — and on nothing
 * else.
 */
class EventCache {
  private key = "";
  private cached: SolarSnapshot | null = null;

  read(at: Date, where: Coordinates): SolarSnapshot {
    const key = `${at.getUTCFullYear()}-${at.getUTCMonth()}-${at.getUTCDate()}:${where.latitude},${where.longitude}`;
    const fresh = solarSnapshot(at, where);
    if (key !== this.key) {
      this.key = key;
      this.cached = fresh;
    }
    // Position is always current; the event times come from the cached day.
    return this.cached
      ? {
          ...fresh,
          sunrise: this.cached.sunrise,
          sunset: this.cached.sunset,
          dawn: this.cached.dawn,
          dusk: this.cached.dusk,
          solarNoon: this.cached.solarNoon,
          polar: this.cached.polar,
        }
      : fresh;
  }
}

export class EnvironmentClock {
  private source: ClockSource;
  private location: Coordinates;
  private publish: (state: EnvironmentState) => void;
  private reducedMotion: boolean;

  private events = new EventCache();
  private current: EnvironmentState | null = null;
  private published: EnvironmentState | null = null;

  private frame: number | null = null;
  private lastTick = 0;

  /** Simulator state. `simulatedAt` of null means the real clock is in charge. */
  private simulatedAt: number | null = null;
  private speed = 1;

  /** Frame timings, and whether this machine has been judged too slow. */
  private intervals: number[] = [];
  private lowPower = false;
  private onLowPower: (low: boolean) => void;

  constructor(options: ClockOptions) {
    this.source = { ...defaultSource(), ...options.source };
    this.location = options.location;
    this.publish = options.publish;
    this.reducedMotion = options.reducedMotion ?? false;
    this.onLowPower = options.onLowPower ?? (() => {});
    this.lastTick = this.source.now();
  }

  /** The instant being rendered — real, or the simulator's. */
  private instant(): number {
    return this.simulatedAt ?? this.source.now();
  }

  /** The target state for right now, with no easing applied. */
  target(): EnvironmentState {
    const at = new Date(this.instant());
    const sun = this.events.read(at, this.location);
    return environmentFor(sun, moonSnapshot(at, this.location));
  }

  /** The state as currently rendered, easing included. */
  read(): EnvironmentState {
    return this.current ?? this.target();
  }

  /** Where the sun actually is, for the simulator's readout. */
  solar(): SolarSnapshot {
    return this.events.read(new Date(this.instant()), this.location);
  }

  start(): void {
    if (this.frame !== null) return;
    // The first frame is not eased. There is nothing to ease *from*, and easing
    // in from an arbitrary starting state is exactly the visible jump this
    // whole design exists to avoid.
    this.snap();
    this.lastTick = this.source.now();
    this.loop();
  }

  stop(): void {
    if (this.frame === null) return;
    this.source.cancelFrame(this.frame);
    this.frame = null;
  }

  /**
   * Jump straight to the true state for the current instant.
   *
   * Used on the first frame, on returning from a backgrounded tab, and whenever
   * the simulator scrubs. §11 is specific about the background case: a tab left
   * open overnight must reconcile to *now*, not animate through the twelve
   * hours it slept through.
   */
  snap(): void {
    this.current = this.target();
    this.flush(true);
  }

  setLocation(where: Coordinates): void {
    this.location = where;
    // Not snapped. Coordinates arriving mid-session should reconcile smoothly —
    // §18's "avoid jarring visual teleportation". The easing handles it.
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  /** Whether the scene has been cut back for a machine that could not keep up. */
  isLowPower(): boolean {
    return this.lowPower;
  }

  /**
   * Force low power on or off, for the developer panel.
   *
   * Latches the measurement off as well: once a person has made the call, the
   * frame watcher must not quietly overrule them a second later.
   */
  setLowPower(low: boolean): void {
    this.intervals = [];
    this.lowPower = low;
    this.onLowPower(low);
  }

  /**
   * Watch what the scene actually costs, and cut back if it is too much.
   *
   * Latches on and never off. Flapping between a full and a reduced scene would
   * be far more distracting than either one — and a device that struggled once
   * under this load will struggle again.
   */
  private judgePerformance(elapsed: number): void {
    if (this.lowPower) return;
    // Throttling and sleep are not slowness. See THROTTLE_FLOOR_MS.
    if (elapsed <= 0 || elapsed > THROTTLE_FLOOR_MS) return;

    this.intervals.push(elapsed);
    if (this.intervals.length < FRAME_SAMPLE) return;

    // Median, not mean: one 300ms hitch while a font loads should not condemn
    // an otherwise healthy machine, and a mean is exactly what such a hitch
    // drags across the threshold.
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.intervals = [];

    if (median > FRAME_BUDGET_MS) {
      this.lowPower = true;
      this.onLowPower(true);
    }
  }

  /** Simulator control. Scrubbing snaps, because a scrub is not a transition. */
  override(next: ClockOverride): void {
    if (next.location) this.location = next.location;
    if (next.speed !== undefined) this.speed = next.speed;
    if (next.at !== undefined) {
      this.simulatedAt = next.at;
      this.snap();
    }
  }

  private loop = (): void => {
    this.frame = this.source.requestFrame(() => {
      this.tick();
      if (this.frame !== null) this.loop();
    });
  };

  /**
   * One step.
   *
   * `elapsed` comes from the wall clock rather than from a frame counter, which
   * is what makes the easing frame-rate independent — and what makes a throttled
   * background tab correct rather than merely slow: fewer, longer steps land in
   * the same place.
   */
  tick(): void {
    const wall = this.source.now();
    const elapsed = Math.max(0, wall - this.lastTick);
    this.lastTick = wall;

    this.judgePerformance(elapsed);

    // Simulated time advances by its own multiplier, so a scrubber at 600×
    // crosses a whole day in a couple of minutes while the easing still runs at
    // a believable rate.
    if (this.simulatedAt !== null && this.speed !== 1) {
      this.simulatedAt += elapsed * this.speed;
    } else if (this.simulatedAt !== null) {
      this.simulatedAt += elapsed;
    }

    const target = this.target();

    if (this.reducedMotion || !this.current) {
      this.current = target;
    } else {
      this.current = ease(this.current, target, elapsed);
    }

    this.flush(false);
  }

  private flush(force: boolean): void {
    if (!this.current) return;
    if (!force && this.published && !worthPublishing(this.published, this.current)) return;
    this.published = this.current;
    this.publish(this.current);
  }
}

/** Move every numeric field toward its target at its own rate. */
function ease(current: EnvironmentState, target: EnvironmentState, elapsed: number): EnvironmentState {
  const next = { ...target };
  for (const key of Object.keys(target) as (keyof EnvironmentState)[]) {
    const to = target[key];
    const from = current[key];
    if (typeof to !== "number" || typeof from !== "number") continue;
    const halfLife = HALF_LIFE_MS[key] ?? DEFAULT_HALF_LIFE_MS;
    (next[key] as number) = approach(from, to, halfLife, elapsed);
  }
  return next;
}

function worthPublishing(published: EnvironmentState, current: EnvironmentState): boolean {
  if (published.phase !== current.phase) return true;
  for (const key of Object.keys(current) as (keyof EnvironmentState)[]) {
    const a = published[key];
    const b = current[key];
    if (typeof a === "number" && typeof b === "number" && Math.abs(a - b) >= EPSILON) return true;
  }
  return false;
}

/**
 * A usable location before anyone has been asked for one.
 *
 * The specification never says what is on screen while location resolves, and
 * the natural implementation renders a default sky and then jumps when
 * coordinates arrive — a hard cut on the most visible frame of the whole
 * feature.
 *
 * This costs nothing to avoid. The browser's UTC offset already gives the
 * user's approximate longitude — the Earth turns 15° an hour — with no
 * permission, no network and no delay. Latitude is genuinely unknown, and 0 is
 * the honest choice rather than a flattering one: at the equator the sun rises
 * near six and sets near six, which is the least wrong guess available for
 * somebody who could be anywhere.
 *
 * The result is that the page opens in roughly the right part of the cycle, and
 * real coordinates then refine it by easing rather than by cutting.
 */
export function estimateLocationFromClock(at: Date = new Date()): Coordinates {
  // `getTimezoneOffset` is minutes to ADD to local time to reach UTC, so it is
  // positive west of Greenwich — the opposite sign to longitude.
  const offsetMinutes = -at.getTimezoneOffset();
  const longitude = Math.max(-180, Math.min(180, offsetMinutes / 4));
  return { latitude: 0, longitude: Number(longitude.toFixed(1)), source: "default" };
}
