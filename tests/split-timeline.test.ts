import { describe, expect, it } from "vitest";
import { splitTimeline } from "@/lib/split-timeline";

/**
 * "Last activity in 2 days."
 *
 * That is what the contact panel said, above a row for a meeting booked for
 * Friday, on a contact whose real last contact had been two hours earlier. The
 * timeline carries scheduled meetings as well as history and is sorted newest
 * first, so `entries[0]` was a thing that had not happened.
 *
 * A summary line that contradicts the rows beneath it is worse than no summary:
 * it is the one part of the panel a reader takes on trust without scrolling.
 */

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

/** Newest first, which is the order the panel loads them in. */
const timeline = (...hours: number[]) => hours.map((h) => ({ at: at(h), h }));

describe("telling what happened from what is booked", () => {
  it("does not call a scheduled meeting the last activity", () => {
    // The exact reported shape: a meeting in 2 days, a note 2 hours back.
    const { lastPast, nextUp } = splitTimeline(timeline(48, -2, -26), NOW);
    expect(lastPast?.h, "a future entry was reported as the last activity").toBe(-2);
    expect(nextUp?.h).toBe(48);
  });

  it("reports nothing scheduled when everything is in the past", () => {
    const { lastPast, nextUp } = splitTimeline(timeline(-2, -26, -50), NOW);
    expect(lastPast?.h).toBe(-2);
    expect(nextUp, "invented something upcoming").toBeUndefined();
  });

  it("reports the soonest of several bookings, not the furthest", () => {
    /* Newest-first ordering makes the soonest future entry the LAST of the
       future ones, which is the reversal this is here to pin down. */
    const { nextUp } = splitTimeline(timeline(200, 72, 6, -2), NOW);
    expect(nextUp?.h, "named the furthest booking instead of the next one").toBe(6);
  });

  it("says nothing has happened when only bookings exist", () => {
    // A contact created today with a meeting booked and no history yet.
    const { lastPast, nextUp } = splitTimeline(timeline(72, 6), NOW);
    expect(lastPast, "claimed a past activity that never happened").toBeUndefined();
    expect(nextUp?.h).toBe(6);
  });

  it("handles an empty timeline", () => {
    const { lastPast, nextUp } = splitTimeline([], NOW);
    expect(lastPast).toBeUndefined();
    expect(nextUp).toBeUndefined();
  });

  it("counts this exact instant as having happened", () => {
    /* The boundary. Something logged at `now` is history, not a booking — a
       strict `<` would have flipped an entry to "next in 0 minutes" the moment
       it was recorded. */
    const { lastPast, nextUp } = splitTimeline(timeline(0), NOW);
    expect(lastPast?.h, "an event happening right now was called upcoming").toBe(0);
    expect(nextUp).toBeUndefined();
  });
});
