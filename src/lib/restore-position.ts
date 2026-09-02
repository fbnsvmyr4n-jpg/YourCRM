/**
 * Put something back where it was in a list.
 *
 * Undoing a payment on the Deals board takes a card that was removed from the
 * pipeline and returns it. Returning it to the FRONT — which is what the first
 * version did — is not an undo: the reader tapped a button to get their board
 * back, and got a board where a card had moved. Position is memory, and on a
 * phone, where only two or three cards are on screen at once, a card that comes
 * back somewhere else reads as a card that has gone missing.
 *
 * Anchored to the item it followed rather than to an index. A position on a
 * list only means anything relative to its neighbours, and an index goes stale
 * the moment anything else moves — add a deal while the undo bar is up and
 * every index below it is wrong. The index is kept only for the case where that
 * neighbour has itself disappeared, which is the one case where there is
 * nothing better to go on.
 *
 * Pure, and separate from the board, because the off-by-one lives here: this is
 * the part that a screenshot of a working undo would not have caught.
 */
export function restoreAt<T>(
  list: readonly T[],
  item: T,
  idOf: (item: T) => string,
  /** The id of the item it used to sit behind — null when it was first. */
  followedId: string | null,
  /** Where it was, used only when that neighbour is gone too. */
  rememberedIndex: number
): T[] {
  const next = [...list];
  const follows = followedId === null ? -1 : next.findIndex((d) => idOf(d) === followedId);
  const slot =
    followedId === null
      ? 0
      : follows >= 0
        ? follows + 1
        : /* Its neighbour has gone too, so the remembered index is all that is
             left. Handed to `splice` unclamped on purpose: it already pins an
             index past the end to the end and a negative one to the start,
             which is exactly the wanted behaviour. A hand-written clamp here
             was provably identical in every case — a mutation deleting it
             changed no result at all, which is the definition of code that is
             not doing anything. */
          rememberedIndex;
  next.splice(slot, 0, item);
  return next;
}
