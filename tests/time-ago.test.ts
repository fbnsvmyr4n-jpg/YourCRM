/*
   "2 hours ago", and above all not "shortly" about something that just
   happened.

   This label has now been wrong in the same direction twice, for two different
   reasons, which is why it finally has a test:

   1. The shared clock was floored to the minute, so the start of the current
      minute sat BEFORE anything logged during it, and an event from ten seconds
      ago rendered as "shortly" — in the future.
   2. Fixed by making the clock exact, it still only ticks every 30 seconds. So
      anything created between two ticks is stamped later than the clock it is
      compared against, and said "shortly" again. Found by saving a draft and
      watching the row claim it was about to be written.

   Both are the same mistake underneath: treating "ahead of my clock" as "in the
   future" when the clock is not current enough to tell the difference.
*/
import { describe, expect, it } from "vitest";
import { relativeLabel } from "@/components/ui/TimeAgo";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const at = (secondsFromNow: number) => new Date(NOW + secondsFromNow * 1000).toISOString();

describe("something that just happened", () => {
  it("is 'just now', whichever side of the clock it lands on", () => {
    expect(relativeLabel(at(0), NOW)).toBe("just now");
    expect(relativeLabel(at(-5), NOW)).toBe("just now");
    /* The case that was broken: a row written a moment AFTER the last tick. */
    expect(relativeLabel(at(1), NOW)).toBe("just now");
    expect(relativeLabel(at(20), NOW)).toBe("just now");
    /* The whole tick interval, which is as far ahead as the clock can be
       stale. */
    expect(relativeLabel(at(30), NOW)).toBe("just now");
  });

  it("never says the future about a record that already exists", () => {
    for (let s = -44; s <= 30; s += 1) {
      expect(relativeLabel(at(s), NOW)).not.toBe("shortly");
    }
  });
});

describe("something genuinely still to come", () => {
  it("still reads as the future once it is further off than the clock is stale", () => {
    /* A meeting at four o'clock has to keep saying so — the tolerance above
       must not swallow real upcoming times. */
    /* The narrow band that is past the clock's staleness and still under a
       minute. "shortly" is now only ever said about this, which is the only
       thing it was ever a true description of. */
    expect(relativeLabel(at(40), NOW)).toBe("shortly");
    expect(relativeLabel(at(45), NOW)).toBe("in 1 minute");
    expect(relativeLabel(at(600), NOW)).toBe("in 10 minutes");
    expect(relativeLabel(at(7200), NOW)).toBe("in 2 hours");
    expect(relativeLabel(at(172800), NOW)).toBe("in 2 days");
  });
});

describe("the past", () => {
  it("reads in the unit that fits", () => {
    expect(relativeLabel(at(-60), NOW)).toBe("1 minute ago");
    expect(relativeLabel(at(-600), NOW)).toBe("10 minutes ago");
    expect(relativeLabel(at(-7200), NOW)).toBe("2 hours ago");
    expect(relativeLabel(at(-172800), NOW)).toBe("2 days ago");
    expect(relativeLabel(at(-5184000), NOW)).toBe("2 months ago");
    expect(relativeLabel(at(-63072000), NOW)).toBe("2 years ago");
  });

  it("says one of a unit without a plural", () => {
    expect(relativeLabel(at(-3600), NOW)).toBe("1 hour ago");
    expect(relativeLabel(at(-86400), NOW)).toBe("1 day ago");
  });
});
