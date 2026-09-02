import { describe, expect, it } from "vitest";
import { restoreAt } from "../src/lib/restore-position";

/**
 * Undoing a payment has to give back the board that was there.
 *
 * Reported directly: a card that came back to the top of its column rather than
 * its own slot. On a phone, where two or three cards are on screen at a time, a
 * card that reappears somewhere else does not read as "restored" — it reads as
 * lost, and the reader scrolls the column looking for it.
 *
 * The logic is anchored to a neighbour rather than an index, so these cases are
 * mostly about what happens when the board has changed underneath.
 */

type Item = { id: string };
const ids = (list: Item[]) => list.map((d) => d.id).join(",");
const put = (list: string[], item: string, followed: string | null, index: number) =>
  ids(restoreAt(list.map((id) => ({ id })), { id: item }, (d) => d.id, followed, index));

describe("putting a card back where it was", () => {
  it("goes behind the card it used to follow", () => {
    expect(put(["a", "b", "d", "e"], "c", "b", 2)).toBe("a,b,c,d,e");
  });

  it("goes back to the front when it was first", () => {
    // Not "behind nothing", which an anchor-only version would read as "at the
    // end" — the commonest card to settle is the one at the top of the column.
    expect(put(["b", "c"], "a", null, 0)).toBe("a,b,c");
  });

  it("goes back to the end when it was last", () => {
    expect(put(["a", "b"], "c", "b", 2)).toBe("a,b,c");
  });

  it("still lands correctly when something was added above it", () => {
    /* The reason this is anchored and not an index: a deal added while the undo
       bar is up shifts every index below it. The neighbour does not move. */
    expect(put(["new", "a", "b", "d"], "c", "b", 2)).toBe("new,a,b,c,d");
  });

  it("still lands correctly when something was removed above it", () => {
    expect(put(["b", "d"], "c", "b", 2)).toBe("b,c,d");
  });

  it("falls back to where it was when its neighbour has gone too", () => {
    // Both its neighbour and the position are stale; the remembered index is
    // the only thing left, and it is better than the top of the list.
    expect(put(["a", "d", "e"], "c", "b", 2)).toBe("a,d,c,e");
  });

  it("lands at the end when the remembered index is past it", () => {
    /* The list has shrunk since. `splice` pins this to the end rather than
       throwing or leaving a hole, which is what the fallback relies on. */
    expect(put(["a"], "z", "gone", 9)).toBe("a,z");
  });

  it("lands at the start when the remembered index is negative", () => {
    expect(put(["a", "b"], "z", "gone", -3)).toBe("z,a,b");
  });

  it("leaves the list it was given alone", () => {
    // The board's state is handed straight to React; mutating it in place is
    // how a render silently keeps the old array and shows nothing.
    const original = [{ id: "a" }, { id: "b" }];
    restoreAt(original, { id: "c" }, (d) => d.id, "a", 1);
    expect(ids(original)).toBe("a,b");
  });
});
