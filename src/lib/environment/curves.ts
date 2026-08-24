/**
 * The shapes light changes in.
 *
 * Kept in one file and reused, rather than each layer easing its own way,
 * because the thing that makes a cycle read as a single continuous world is
 * that everything in it moves by the same rules. Sky and water disagreeing
 * about how fast dusk arrives is exactly the kind of seam §22 asks a human to
 * hunt for.
 *
 * Every function here is pure and total: real number in, real number out, no
 * `NaN` reachable from finite input. That is what makes the sweep tests
 * meaningful — they can only prove the composition is sound if the pieces
 * cannot individually produce nonsense.
 */

export function clamp01(value: number): number {
  // NaN first and by itself, because `Math.min(Math.max(NaN, 0), 1)` is NaN and
  // would sail straight through into the render state. This is the cheapest
  // place in the system to stop that, so it is stopped here rather than guarded
  // for at every call site.
  //
  // The infinities are deliberately NOT lumped in with it. NaN means "no
  // answer", and 0 is the honest response; ±Infinity means "past the end",
  // which clamps to the end like any other out-of-range number. Treating
  // +Infinity as 0 would turn an overflow into a silent blackout — darkness
  // reported with total confidence, which is the harder failure to spot.
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * clamp01(t);
}

/**
 * Where `value` sits between two bounds, as 0…1.
 *
 * Equal bounds return 0 rather than dividing by zero. A zero-width band is a
 * configuration mistake, and the honest response is "not in it" — `Infinity`
 * would propagate silently, and throwing would take down a login screen over a
 * decorative gradient.
 */
export function progress(value: number, from: number, to: number): number {
  if (from === to) return 0;
  return clamp01((value - from) / (to - from));
}

/**
 * Smoothstep: ease in and out, flat at both ends.
 *
 * The default shape for anything that has to arrive and leave without a visible
 * edge. Linear interpolation is continuous in *value* but not in its rate of
 * change, and the eye reads that discontinuity as a crease — light appears to
 * "arrive" at the moment the ramp starts. Smoothstep is flat at both ends, so
 * transitions begin and end invisibly, which is the entire requirement of §10.
 */
export function smoothstep(value: number, from: number, to: number): number {
  const t = progress(value, from, to);
  return t * t * (3 - 2 * t);
}

/**
 * A response that rises, peaks and falls again.
 *
 * For anything that is strongest in the middle of a range rather than at one
 * end — warmth, which peaks at golden hour and falls away toward both noon and
 * night, or a reflection that is at its longest when the sun is near the
 * horizon and gone when it is overhead or well below it.
 *
 * The peak need not be centred: `peak` is where the value reaches 1, and the
 * two sides are eased independently, so a slow build into a fast fall is
 * expressible. Sunset is not symmetrical and should not be modelled as if it
 * were.
 */
export function ridge(value: number, from: number, peak: number, to: number): number {
  if (value <= from || value >= to) return 0;
  return value < peak
    ? smoothstep(value, from, peak)
    : 1 - smoothstep(value, peak, to);
}

/**
 * Move a value toward a target by a fraction of the remaining distance.
 *
 * Frame-rate independent, which the naive `current + (target - current) * 0.1`
 * is not: that version eases twice as fast at 120fps as at 60, so the same
 * scene settles at different speeds on different machines. Expressed instead as
 * a half-life — how long it takes to close half the gap — which is a duration a
 * person can reason about and a monitor cannot change.
 */
export function approach(current: number, target: number, halfLifeMs: number, elapsedMs: number): number {
  // No easing configured: there is nothing to travel through, so arrive.
  if (halfLifeMs <= 0) return target;
  // Nothing to ease FROM.
  if (!Number.isFinite(current)) return target;

  /**
   * No time passed means no movement — not instant arrival.
   *
   * This returned `target` at first, which is a jump dressed as an easing. Two
   * ways it fires, and the second is the one that matters: two frames landing
   * in the same millisecond on a fast machine, and the system clock stepping
   * BACKWARDS — an NTP correction, the end of daylight saving, or somebody
   * setting their clock. §20 lists that last case in the test matrix, and the
   * old behaviour answered it with the exact hard cut §29 forbids.
   */
  if (elapsedMs <= 0) return current;

  const remaining = Math.pow(0.5, elapsedMs / halfLifeMs);
  return target + (current - target) * remaining;
}
