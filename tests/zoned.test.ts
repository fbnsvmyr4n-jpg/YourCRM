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

  it("IS RIGHT ON THE DAY THE CLOCK CHANGES, NOT ONLY IN THE MIDDLE OF A SEASON", () => {
    /*
       The defect this function shipped with, and the reason the test above did
       not catch it: mid-January and mid-July are the easy cases. The offset was
       measured at the wall-clock-read-as-UTC instant, which is a DIFFERENT
       moment from the answer — same side of a boundary in the middle of a
       season, and the wrong side of it near a transition.

       On 8 March 2026 New York springs forward at 02:00. Every local time after
       that came back an hour late: 03:00 gave 08:00Z, which is 04:00 in New
       York. A meeting booked for three was stored as four, and every screen
       agreed with itself afterwards, because the calendar renders the stored
       instant back. The only person who found out was whoever arrived early.

       Read these as: local time → the instant it really is.
    */
    const nyc = (date: string, time: string) => wallClockToInstant(date, time, "America/New_York");

    // Before the change: EST, UTC-5.
    expect(nyc("2026-03-08", "00:30")).toBe("2026-03-08T05:30:00.000Z");
    expect(nyc("2026-03-08", "01:30")).toBe("2026-03-08T06:30:00.000Z");

    // After it: EDT, UTC-4. These were all an hour out.
    expect(nyc("2026-03-08", "03:00")).toBe("2026-03-08T07:00:00.000Z");
    expect(nyc("2026-03-08", "09:00")).toBe("2026-03-08T13:00:00.000Z");
    expect(nyc("2026-03-08", "15:00")).toBe("2026-03-08T19:00:00.000Z");
    expect(nyc("2026-03-08", "23:30")).toBe("2026-03-09T03:30:00.000Z");

    // And the autumn transition, the other direction.
    expect(nyc("2026-11-01", "00:30")).toBe("2026-11-01T04:30:00.000Z"); // EDT
    expect(nyc("2026-11-01", "09:00")).toBe("2026-11-01T14:00:00.000Z"); // EST
  });

  it("holds in a southern-hemisphere zone, where the seasons are reversed", () => {
    /* Sydney does the opposite of New York, so a fix that merely leaned one
       way would show up here. Australia moves at 02:00/03:00 local on the
       first Sunday in April and October. */
    const syd = (date: string, time: string) => wallClockToInstant(date, time, "Australia/Sydney");
    expect(syd("2026-04-05", "09:00")).toBe("2026-04-04T23:00:00.000Z"); // AEST, UTC+10
    expect(syd("2026-10-04", "09:00")).toBe("2026-10-03T22:00:00.000Z"); // AEDT, UTC+11
  });

  it("still answers correctly in a zone that never changes", () => {
    // The common case for this product, and the one that must not regress.
    expect(wallClockToInstant("2026-03-08", "09:00", "Africa/Johannesburg")).toBe(
      "2026-03-08T07:00:00.000Z"
    );
    expect(wallClockToInstant("2026-11-01", "09:00", "Africa/Johannesburg")).toBe(
      "2026-11-01T07:00:00.000Z"
    );
  });

  it("round-trips every hour of both transition days", () => {
    /*
       A property rather than a handful of points: for every hour that really
       exists, converting to an instant and back must give the hour we asked
       for. The hours that do not exist are allowed to differ — that is what
       makes them detectable, and `booking/slots.ts` relies on exactly this to
       avoid offering them.
    */
    for (const date of ["2026-03-08", "2026-11-01"]) {
      let survived = 0;
      for (let h = 0; h < 24; h++) {
        const time = `${String(h).padStart(2, "0")}:00`;
        const iso = wallClockToInstant(date, time, "America/New_York");
        expect(iso, `${date} ${time} produced nothing`).not.toBeNull();
        if (instantToWallClock(iso!, "America/New_York")?.time === time) survived++;
      }
      // Spring forward loses 02:00; autumn keeps all 24 (01:00 simply repeats).
      expect(survived, `${date} did not round-trip the hours it should`).toBe(
        date === "2026-03-08" ? 23 : 24
      );
    }
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
