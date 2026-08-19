import { describe, expect, it } from "vitest";
import { instantToWallClock, parseWallTime, wallClockToInstant } from "../src/lib/zoned";

/**
 * The wall-clock conversion.
 *
 * Worth testing directly because its failure mode is quiet: a meeting simply
 * sits at the wrong hour, and nothing errors. The migration rehearsal found
 * exactly that — the same booking landed two hours apart depending on which
 * machine processed it, because `new Date("...T14:00:00")` reads the host's
 * zone. These tests pin the behaviour to a named zone instead.
 */

describe("parsing a typed time", () => {
  it("reads both 24-hour and 12-hour input", () => {
    expect(parseWallTime("14:00")).toEqual({ hour: 14, minute: 0 });
    expect(parseWallTime("2:00 pm")).toEqual({ hour: 14, minute: 0 });
    expect(parseWallTime("2:00pm")).toEqual({ hour: 14, minute: 0 });
    expect(parseWallTime("9:30 am")).toEqual({ hour: 9, minute: 30 });
  });

  it("handles the two midnight cases people get wrong", () => {
    expect(parseWallTime("12:00 am"), "12am is midnight, not noon").toEqual({ hour: 0, minute: 0 });
    expect(parseWallTime("12:00 pm"), "12pm is noon, not midnight").toEqual({ hour: 12, minute: 0 });
  });

  it("refuses nonsense rather than rounding it into range", () => {
    // A broken input is worth rejecting: silently storing 23:59 for "25:00"
    // produces a meeting nobody booked.
    for (const bad of ["25:00", "12:99", "half past two", "", "2pm"]) {
      expect(parseWallTime(bad), `"${bad}" was accepted`).toBeNull();
    }
  });
});

describe("wall clock to instant", () => {
  it("interprets the time in the zone it is given, not the host's", () => {
    // The defect this exists to prevent, stated as an assertion: 2pm in
    // Johannesburg (UTC+2) is 12:00 UTC, wherever this test runs.
    expect(wallClockToInstant("2026-03-01", "14:00", "Africa/Johannesburg")).toBe(
      "2026-03-01T12:00:00.000Z"
    );
    expect(wallClockToInstant("2026-03-01", "14:00", "UTC")).toBe("2026-03-01T14:00:00.000Z");
    expect(wallClockToInstant("2026-03-01", "14:00", "America/New_York")).toBe(
      "2026-03-01T19:00:00.000Z"
    );
  });

  it("uses the offset for that date, so daylight saving is handled", () => {
    // New York is UTC-5 in January and UTC-4 in July. A fixed offset would put
    // one of these an hour out.
    expect(wallClockToInstant("2026-01-15", "12:00", "America/New_York")).toBe(
      "2026-01-15T17:00:00.000Z"
    );
    expect(wallClockToInstant("2026-07-15", "12:00", "America/New_York")).toBe(
      "2026-07-15T16:00:00.000Z"
    );
  });

  it("returns null for an unparseable date, time or zone", () => {
    // Never a guess. An unrecognised zone is a configuration error, and
    // falling back to UTC would store a time nobody meant.
    expect(wallClockToInstant("not-a-date", "14:00", "UTC")).toBeNull();
    expect(wallClockToInstant("2026-03-01", "half two", "UTC")).toBeNull();
    expect(wallClockToInstant("2026-03-01", "14:00", "Mars/Olympus")).toBeNull();
  });
});

describe("round trip", () => {
  it("gives back the time the person typed", () => {
    // What they entered is what they should see, in their own zone, whatever
    // the database stored underneath.
    for (const zone of ["UTC", "Africa/Johannesburg", "America/New_York", "Asia/Kolkata"]) {
      const iso = wallClockToInstant("2026-06-10", "09:45", zone)!;
      expect(instantToWallClock(iso, zone), `round trip failed in ${zone}`).toEqual({
        date: "2026-06-10",
        time: "09:45",
      });
    }
  });

  it("survives a half-hour offset zone", () => {
    // Kolkata is UTC+5:30. Offsets are not all whole hours, and code that
    // assumes they are is wrong twice a day for a fifth of the world.
    expect(wallClockToInstant("2026-06-10", "09:45", "Asia/Kolkata")).toBe(
      "2026-06-10T04:15:00.000Z"
    );
  });
});
