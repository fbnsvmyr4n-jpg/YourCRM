/**
 * Divide a timeline into what has happened and what is still to come.
 *
 * A contact's timeline carries scheduled meetings alongside history, sorted
 * newest first. Taking `entries[0]` as "the last thing that happened" therefore
 * picked up a meeting booked for Friday, and the panel's summary read
 * **"Last activity in 2 days"** — the line contradicting itself, on a contact
 * whose real last contact had been two hours earlier.
 *
 * Both halves are worth saying. "You spoke two hours ago, you are due to meet on
 * Friday" is one situation described by two facts, and the panel exists to
 * answer exactly that, so this returns both rather than filtering the future
 * out.
 *
 * `now` is passed in rather than read here: the caller takes it from the shared
 * clock every timestamp on the page measures against, which is null until
 * hydration and therefore cannot be consulted during a server render.
 */
export function splitTimeline<T extends { at: string }>(
  /** Newest first — the order the timeline is already loaded in. */
  entries: readonly T[],
  now: number
): { lastPast: T | undefined; nextUp: T | undefined } {
  /* Newest first means the first entry not in the future is the most recent
     past one, and everything before it is scheduled. One scan, and it cannot
     disagree with the order of the rows below it. */
  const firstPast = entries.findIndex((e) => Date.parse(e.at) <= now);

  if (firstPast === -1) {
    // Nothing has happened yet. The soonest future entry is the LAST one,
    // because the list runs newest first.
    return { lastPast: undefined, nextUp: entries[entries.length - 1] };
  }

  return {
    lastPast: entries[firstPast],
    /* The entry just before it is the soonest one still ahead. At index 0 that
       reads `entries[-1]`, which is `undefined` — nothing is scheduled, which
       is the right answer. An explicit `firstPast === 0 ? undefined :` guard
       stood here and was provably identical in every case: a mutation deleting
       it changed no result, which is the definition of code that is not doing
       anything. */
    nextUp: entries[firstPast - 1],
  };
}
