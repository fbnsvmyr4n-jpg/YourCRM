/**
 * How fast a scroll container should move while something is dragged near its
 * edge.
 *
 * The deals board is a horizontal scroller wider than the window. Dragging a
 * card toward a stage that is off screen did nothing: the card stopped at the
 * edge, so the only way to reach a later stage was to drop the card somewhere
 * it did not belong, scroll, and pick it up again. Every board that scrolls
 * solves this by scrolling itself when the pointer nears an edge.
 *
 * The maths is here rather than inline in the component because the whole
 * behaviour lives in it — which edge, how deep, how fast, and when to stop —
 * and none of that is observable from a test that can only read markup.
 */

/** Distance from an edge, in px, within which the container starts moving. */
export const EDGE_ZONE = 110;
/**
 * Fastest scroll, in px per 60fps frame.
 *
 * Kept as a per-frame figure because that is how it reads at a glance, but it
 * is scaled by real elapsed time before use — see `FRAME_MS`. Measured on a
 * 120Hz display the unscaled version moved 399px where a 60Hz display moved
 * 198, so the board was twice as fast on better hardware.
 */
export const EDGE_MAX_SPEED = 22;

/** One frame at 60fps. Elapsed time is divided by this to keep speed honest. */
export const FRAME_MS = 1000 / 60;

/**
 * How far to scroll for a frame that actually took `elapsedMs`.
 *
 * Without this the distance travelled depends on the refresh rate: the same
 * drag moves twice as far on a 120Hz screen as on a 60Hz one, which is a
 * different feel on different machines rather than a chosen one.
 *
 * The elapsed time is capped at four frames. A backgrounded tab or a long task
 * can hand back a gap of hundreds of milliseconds, and without a cap the first
 * frame after it would jump the board across several columns.
 */
export function edgeScrollStep(velocity: number, elapsedMs: number): number {
  const frames = Math.min(4, Math.max(0, elapsedMs) / FRAME_MS);
  return velocity * frames;
}

export type Edges = { left: number; right: number };

/**
 * Signed pixels-per-frame: negative scrolls left, positive right, 0 holds.
 *
 * Speed ramps with depth into the zone rather than switching on, so a pointer
 * resting just inside the boundary creeps and one pinned to the edge moves at
 * full speed. A constant speed makes precise drops near the edge impossible,
 * because the moment you enter the zone the board leaves under you.
 *
 * @param clientX pointer position in viewport coordinates
 * @param edges   the container's own left/right in the same coordinates
 * @param zone    override for the trigger distance; the default is the export above
 * @param max     override for the top speed
 */
export function edgeScrollVelocity(
  clientX: number,
  edges: Edges,
  zone: number = EDGE_ZONE,
  max: number = EDGE_MAX_SPEED
): number {
  /* A container narrower than two zones would have them overlap, and a pointer
     in the middle would belong to both. Nothing sensible to do, so nothing. */
  if (edges.right - edges.left <= zone * 2) return 0;

  if (clientX < edges.left + zone) {
    /* Depth is clamped, so a pointer dragged BEYOND the container — off the
       window entirely — scrolls at full speed rather than accelerating without
       limit the further out it goes. */
    const depth = Math.min(1, (edges.left + zone - clientX) / zone);
    return -max * depth;
  }

  if (clientX > edges.right - zone) {
    const depth = Math.min(1, (clientX - (edges.right - zone)) / zone);
    return max * depth;
  }

  return 0;
}
