import { describe, expect, it } from "vitest";
import {
  addDays,
  flatten,
  generateSlots,
  isOffered,
  localToInstant,
  weekdayOf,
  type Availability,
  type Busy,
  type SlotRequest,
} from "../src/server/booking/slots";
import type { OpenDay, Weekday } from "../src/server/repos/working-hours";

/**
 * When a stranger can actually book.
 *
 * The calculation where being subtly wrong sends a real person to a real
 * address at a time nobody is there — so these are written as properties about
 * what may and may not be offered, not as a transcript of one happy path.
 *
 * The zone cases are the ones that earn their keep. Opening hours are
 * wall-clock; meetings are instants; and twice a year a local clock either
 * skips an hour or repeats one. Every one of those is a way to show a client
 * 09:00 and write 10:00 into the calendar.
 */

const JHB = "Africa/Johannesburg"; // No DST. The common case.
const NYC = "America/New_York"; // DST, and the transitions are well known.

const day = (weekday: number, opens: number, closes: number): OpenDay => ({
  weekday: weekday as Weekday,
  opensMinute: opens,
  closesMinute: closes,
});

/** Mon–Fri 09:00–17:00. */
const WEEK: OpenDay[] = [1, 2, 3, 4, 5].map((d) => day(d, 9 * 60, 17 * 60));

/** 2026-09-07 is a Monday. Fixed so nothing here depends on the real clock. */
const MONDAY = "2026-09-07";
const BEFORE = new Date("2026-09-01T00:00:00Z");

const ask = (over: Partial<SlotRequest> = {}): Availability =>
  generateSlots({
    week: WEEK,
    holidays: new Set<string>(),
    busy: [],
    timeZone: JHB,
    fromDate: MONDAY,
    days: 1,
    slotMinutes: 30,
    minNoticeMinutes: 0,
    now: BEFORE,
    ...over,
  });

const starts = (a: Availability) => flatten(a).map((s) => s.startsAt);
const ok = (a: Availability) => {
  if (!a.ok) throw new Error(`expected slots, got ${a.reason}: ${a.detail}`);
  return a;
};

describe("nothing configured is not the same as nothing free", () => {
  it("REFUSES when no hours have been set, rather than showing an empty day", () => {
    /*
       The distinction the whole booking page rests on. "We are closed all week"
       and "nobody has told us when we are open" look identical as an empty
       list, and presenting the second as the first sends the client away while
       telling the owner nothing.
    */
    const a = ask({ week: [] });
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.reason).toBe("no_hours");
    expect(a.detail).toMatch(/opening hours/i);
  });

  it("is a real answer, not a thrown error", () => {
    expect(() => ask({ week: [] })).not.toThrow();
  });

  it("distinguishes a genuinely full week from an unconfigured one", () => {
    /* Same shape of output — no slots — but one is `ok` and the other is not,
       which is what lets the page say two different things. */
    const busy: Busy[] = [{ startsAt: "2026-09-07T07:00:00Z", durationMin: 8 * 60 }];
    const full = ask({ busy });
    expect(full.ok).toBe(true);
    expect(flatten(full)).toHaveLength(0);
    expect(ask({ week: [] }).ok).toBe(false);
  });

  it("refuses a zone it cannot resolve rather than quietly using UTC", () => {
    const a = ask({ timeZone: "Mars/Olympus_Mons" });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("unknown_zone");
  });
});

describe("a slot fits inside the opening hours", () => {
  it("starts when the day opens and never runs past closing", () => {
    const a = ok(ask());
    const list = flatten(a);
    expect(list).toHaveLength(16); // 09:00–17:00 in 30-minute steps

    // 09:00 in Johannesburg is 07:00 UTC — the zone is doing real work here.
    expect(list[0].startsAt).toBe("2026-09-07T07:00:00.000Z");
    expect(list[0].endsAt).toBe("2026-09-07T07:30:00.000Z");
    expect(list[list.length - 1].startsAt).toBe("2026-09-07T14:30:00.000Z");
    expect(list[list.length - 1].endsAt).toBe("2026-09-07T15:00:00.000Z");
  });

  it("DOES NOT OFFER A SLOT THAT WOULD RUN PAST CLOSING", () => {
    /* A 90-minute meeting cannot start at 16:00 on a day that shuts at 17:00,
       and offering one books somebody half an hour into a locked office. */
    const a = ok(ask({ slotMinutes: 90 }));
    const list = flatten(a);
    // 09:00, 10:30, 12:00, 13:30, 15:00 — the 16:30 start would end at 18:00.
    expect(list).toHaveLength(5);
    expect(list[list.length - 1].endsAt).toBe("2026-09-07T14:30:00.000Z"); // 16:30 local
    for (const s of list) {
      expect(
        Date.parse(s.endsAt),
        "a slot ran past closing"
      ).toBeLessThanOrEqual(Date.parse("2026-09-07T15:00:00.000Z")); // 17:00 local
    }
  });

  it("offers a meeting that fills the day exactly, and nothing longer", () => {
    // 09:00–17:00 is 480 minutes, so a 480-minute meeting fits precisely once.
    expect(flatten(ok(ask({ slotMinutes: 480 })))).toHaveLength(1);

    // A three-hour morning cannot hold a four-hour meeting.
    const morning = [1, 2, 3, 4, 5].map((d) => day(d, 9 * 60, 12 * 60));
    expect(flatten(ok(ask({ week: morning, slotMinutes: 240 })))).toHaveLength(0);
  });

  it("uses its own step when given one, without changing the length", () => {
    const a = ok(ask({ slotMinutes: 60, stepMinutes: 30 }));
    const list = flatten(a);
    expect(list).toHaveLength(15); // 09:00…16:00 every 30 minutes
    expect(list[1].startsAt).toBe("2026-09-07T07:30:00.000Z");
    for (const s of list) {
      expect(Date.parse(s.endsAt) - Date.parse(s.startsAt)).toBe(60 * 60_000);
    }
  });

  it("skips a weekday with no hours", () => {
    // Sunday 2026-09-06 through Saturday 2026-09-12.
    const a = ok(ask({ fromDate: "2026-09-06", days: 7 }));
    expect(a.days.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5]);
  });

  it("omits a day with nothing left rather than listing it empty", () => {
    const a = ok(
      ask({
        days: 2,
        busy: [{ startsAt: "2026-09-07T00:00:00Z", durationMin: 24 * 60 }],
      })
    );
    expect(a.days.map((d) => d.date)).toEqual(["2026-09-08"]);
  });
});

describe("a holiday closes the day whatever the hours say", () => {
  it("drops the day entirely", () => {
    const a = ok(ask({ days: 3, holidays: new Set(["2026-09-08"]) }));
    expect(a.days.map((d) => d.date)).toEqual(["2026-09-07", "2026-09-09"]);
  });

  it("closes it even though the week says that weekday is open", () => {
    const a = ok(ask({ holidays: new Set([MONDAY]) }));
    expect(flatten(a)).toHaveLength(0);
  });
});

describe("a slot never overlaps something already booked", () => {
  it("REMOVES A SLOT A MEETING SITS ON", () => {
    // 10:00–10:30 local = 08:00–08:30 UTC.
    const a = ok(ask({ busy: [{ startsAt: "2026-09-07T08:00:00Z", durationMin: 30 }] }));
    expect(starts(a)).not.toContain("2026-09-07T08:00:00.000Z");
    expect(starts(a)).toContain("2026-09-07T08:30:00.000Z");
    expect(flatten(a)).toHaveLength(15);
  });

  it("removes EVERY slot a long meeting covers, not just the one it starts on", () => {
    /* The defect a start-time-only check produces: a two-hour meeting blocks
       its first half hour and leaves the other three bookable. */
    const a = ok(ask({ busy: [{ startsAt: "2026-09-07T08:00:00Z", durationMin: 120 }] }));
    for (const t of ["08:00", "08:30", "09:00", "09:30"]) {
      expect(starts(a), `${t} was still offered`).not.toContain(`2026-09-07T${t}:00.000Z`);
    }
    expect(flatten(a)).toHaveLength(12);
  });

  it("removes a slot a meeting only partly covers", () => {
    // 10:15–10:45 straddles both the 10:00 and 10:30 slots.
    const a = ok(ask({ busy: [{ startsAt: "2026-09-07T08:15:00Z", durationMin: 30 }] }));
    expect(starts(a)).not.toContain("2026-09-07T08:00:00.000Z");
    expect(starts(a)).not.toContain("2026-09-07T08:30:00.000Z");
  });

  it("KEEPS a slot that merely touches a meeting's edge", () => {
    /* Half-open intervals. Without this every back-to-back appointment would
       eat the slot beside it and the calendar would look far fuller than it is. */
    const a = ok(ask({ busy: [{ startsAt: "2026-09-07T07:30:00Z", durationMin: 30 }] }));
    expect(starts(a), "the slot before a meeting was eaten").toContain(
      "2026-09-07T07:00:00.000Z"
    );
    expect(starts(a), "the slot after a meeting was eaten").toContain("2026-09-07T08:00:00.000Z");
    expect(starts(a)).not.toContain("2026-09-07T07:30:00.000Z");
  });

  it("ignores a meeting on another day", () => {
    const a = ok(ask({ busy: [{ startsAt: "2026-09-08T08:00:00Z", durationMin: 60 }] }));
    expect(flatten(a)).toHaveLength(16);
  });

  it("survives a meeting with a nonsense timestamp instead of blocking everything", () => {
    const a = ok(ask({ busy: [{ startsAt: "not a date", durationMin: 30 }] }));
    expect(flatten(a)).toHaveLength(16);
  });
});

describe("a slot is far enough ahead to be worth offering", () => {
  it("drops everything already past", () => {
    // 11:20 local on the Monday = 09:20 UTC.
    const a = ok(ask({ now: new Date("2026-09-07T09:20:00Z"), minNoticeMinutes: 0 }));
    expect(starts(a)[0]).toBe("2026-09-07T09:30:00.000Z");
  });

  it("HONOURS THE NOTICE, not merely the clock", () => {
    /* Two hours' notice at 09:20 UTC means nothing before 11:20 — so the 11:30
       slot is the first, not the 09:30 one. */
    const a = ok(ask({ now: new Date("2026-09-07T09:20:00Z"), minNoticeMinutes: 120 }));
    expect(starts(a)[0]).toBe("2026-09-07T11:30:00.000Z");
  });

  it("offers a slot starting exactly at the notice boundary", () => {
    const a = ok(ask({ now: new Date("2026-09-07T07:00:00Z"), minNoticeMinutes: 60 }));
    expect(starts(a)).toContain("2026-09-07T08:00:00.000Z");
  });

  it("empties a day that has entirely gone by, without refusing", () => {
    const a = ask({ now: new Date("2026-09-07T20:00:00Z") });
    expect(a.ok).toBe(true);
    expect(flatten(a)).toHaveLength(0);
  });
});

describe("daylight saving, where this either works or ruins an afternoon", () => {
  /*
     New York springs forward at 02:00 on 8 March 2026 and falls back at 02:00
     on 1 November 2026. Both are Sundays, so the working week is opened on
     Sunday for these.
  */
  const sunday = (opens: number, closes: number) => [day(0, opens, closes)];

  it("NEVER OFFERS A LOCAL TIME THAT DOES NOT EXIST", () => {
    /*
       The hour the clock skips. `wallClockToInstant` still returns something
       plausible for 02:30 on this date — offering it would show a client 02:30
       and put 03:30 in the calendar, an hour's difference nobody would notice
       until somebody arrived alone.
    */
    expect(localToInstant("2026-03-08", 2 * 60 + 30, NYC), "02:30 was treated as real").toBeNull();

    const a = ok(
      generateSlots({
        week: sunday(0, 6 * 60),
        holidays: new Set(),
        busy: [],
        timeZone: NYC,
        fromDate: "2026-03-08",
        days: 1,
        slotMinutes: 30,
        minNoticeMinutes: 0,
        now: new Date("2026-01-01T00:00:00Z"),
      })
    );

    /*
       Twelve candidates between 00:00 and 06:00. Nine survive:

         00:00 00:30 01:00   offered
         01:30               dropped — it is 30 real minutes, but its end would
                             have to be labelled 02:00, a time that does not
                             exist that morning
         02:00 02:30         dropped — they do not exist
         03:00 … 05:30       offered

       The rule, stated once: BOTH ends of a slot must be nameable local times,
       and the real gap between them must equal the length advertised. Dropping
       01:30 is the conservative side of that, deliberately — a slot whose
       stated finish time never happens is not one to put in front of a client.
    */
    expect(flatten(a)).toHaveLength(9);
    for (const s of flatten(a)) {
      const local = new Intl.DateTimeFormat("en-GB", {
        timeZone: NYC,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(s.startsAt));
      expect(local, "a skipped hour was offered").not.toMatch(/^02:/);
    }
  });

  it("offers every slot exactly once through the hour that repeats", () => {
    /* Falling back, 01:00–02:00 happens twice. The time is real, so it is
       offered — once. Offering it twice would put two clients in one room and
       be indistinguishable on the page. */
    const a = ok(
      generateSlots({
        week: sunday(0, 4 * 60),
        holidays: new Set(),
        busy: [],
        timeZone: NYC,
        fromDate: "2026-11-01",
        days: 1,
        slotMinutes: 30,
        minNoticeMinutes: 0,
        now: new Date("2026-01-01T00:00:00Z"),
      })
    );
    const list = starts(a);
    expect(new Set(list).size, "the same instant was offered twice").toBe(list.length);
    for (let i = 1; i < list.length; i++) {
      expect(Date.parse(list[i]), "slots came back out of order").toBeGreaterThan(
        Date.parse(list[i - 1])
      );
    }
  });

  it("DROPS A SLOT THAT WOULD LAST LONGER THAN IT SAYS", () => {
    /*
       London puts its clocks back at 02:00 on 25 October 2026, so 01:00–02:00
       local is TWO real hours. A booking page offering "01:00, one hour" would
       be advertising sixty minutes and taking a hundred and twenty.

       This case was missed until a mutation run: deleting the straddle check
       broke nothing, because the only DST test at the time exercised a slot
       whose end simply did not exist, which a different guard catches. The
       first probe for a reachable case came back empty and I nearly recorded
       the mutant as equivalent — the probe had passed, and vitest does not
       print console output for passing tests. Silence was not evidence.
    */
    const london = "Europe/London";
    /* The raw fact, before any generation: midnight to 01:00 is really two
       hours, because 01:00 comes round twice and the later one is what an
       instant resolves to. */
    const midnight = localToInstant("2026-10-25", 0, london)!;
    const oneAm = localToInstant("2026-10-25", 60, london)!;
    expect(oneAm.getTime() - midnight.getTime(), "the fixture is not a straddle").toBe(
      2 * 3600_000
    );

    const a = ok(
      generateSlots({
        week: [day(0, 0, 4 * 60)], // 25 Oct 2026 is a Sunday
        holidays: new Set(),
        busy: [],
        timeZone: london,
        fromDate: "2026-10-25",
        days: 1,
        slotMinutes: 60,
        minNoticeMinutes: 0,
        now: new Date("2026-01-01T00:00:00Z"),
      })
    );

    expect(starts(a), "the straddling hour was offered").not.toContain(midnight.toISOString());
    for (const slot of flatten(a)) {
      expect(
        Date.parse(slot.endsAt) - Date.parse(slot.startsAt),
        "a slot lasted longer than it advertised"
      ).toBe(60 * 60_000);
    }
  });

  it("keeps a slot's real length equal to the length it advertises", () => {
    /* A 30-minute slot must be 30 real minutes. One straddling a transition is
       not, so it is dropped rather than described wrongly. */
    for (const date of ["2026-03-08", "2026-11-01"]) {
      const a = ok(
        generateSlots({
          week: sunday(0, 6 * 60),
          holidays: new Set(),
          busy: [],
          timeZone: NYC,
          fromDate: date,
          days: 1,
          slotMinutes: 30,
          minNoticeMinutes: 0,
          now: new Date("2026-01-01T00:00:00Z"),
        })
      );
      for (const s of flatten(a)) {
        expect(
          Date.parse(s.endsAt) - Date.parse(s.startsAt),
          `a slot on ${date} was not 30 real minutes`
        ).toBe(30 * 60_000);
      }
    }
  });

  it("keeps 09:00 meaning nine in the morning on both sides of a change", () => {
    /* The property a client cares about: the offset moves, the local time does
       not. Before the change 09:00 is 14:00 UTC; after it, 13:00 UTC. */
    const week = [1, 2, 3, 4, 5, 6, 0].map((d) => day(d, 9 * 60, 10 * 60));
    const nine = (date: string) => {
      const a = ok(
        generateSlots({
          week,
          holidays: new Set(),
          busy: [],
          timeZone: NYC,
          fromDate: date,
          days: 1,
          slotMinutes: 60,
          minNoticeMinutes: 0,
          now: new Date("2026-01-01T00:00:00Z"),
        })
      );
      return flatten(a)[0].startsAt;
    };
    expect(nine("2026-03-07")).toBe("2026-03-07T14:00:00.000Z"); // EST
    expect(nine("2026-03-09")).toBe("2026-03-09T13:00:00.000Z"); // EDT
  });

  it("ADVANCES THE DATE WHATEVER ZONE THE SERVER ITSELF IS IN", () => {
    /*
       Found by a mutation run, and the most dangerous thing in this file
       because it depends on the machine rather than the input.

       Writing `addDays` the obvious way — `d.setDate(d.getDate() + 1)` — uses
       the HOST's local calendar. On a server in London, adding a day to
       2026-03-29 (the morning the UK clocks go forward) returns 2026-03-29
       again: the day is 23 hours long, so local midnight plus one local day is
       still the same UTC date once it is sliced back. The day loop below would
       generate the same date over and over and every slot after it would be
       wrong — on a London server, and on no other.

       The implementation does the arithmetic in UTC on a date-only value, so
       the host cannot reach it. This test proves that by moving the host.
    */
    const original = process.env.TZ;
    try {
      for (const zone of ["Europe/London", "America/New_York", "Pacific/Auckland", "UTC"]) {
        process.env.TZ = zone;
        expect(addDays("2026-03-29", 1), `wrong on a ${zone} server`).toBe("2026-03-30");
        expect(addDays("2026-10-25", 1), `wrong on a ${zone} server`).toBe("2026-10-26");
        expect(addDays("2026-11-01", 1), `wrong on a ${zone} server`).toBe("2026-11-02");

        // And the loop it feeds must actually walk forward.
        const seen = new Set<string>();
        for (let i = 0; i < 7; i++) seen.add(addDays("2026-03-27", i)!);
        expect(seen.size, `the day loop stalled on a ${zone} server`).toBe(7);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("counts days as calendar days across a transition, not as 24 hours", () => {
    /* Adding 86,400,000ms to a local instant lands back on the same day when
       the day is 25 hours long. These are dates, so it cannot. */
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // leap year
  });
});

describe("the weekday a date falls on", () => {
  it("agrees with the calendar, and with 0 being Sunday", () => {
    expect(weekdayOf("2026-09-06")).toBe(0); // Sunday
    expect(weekdayOf("2026-09-07")).toBe(1); // Monday
    expect(weekdayOf("2026-09-12")).toBe(6); // Saturday
  });

  it("refuses something that is not a date", () => {
    for (const bad of ["", "2026-9-7", "07/09/2026", "tomorrow"]) {
      expect(weekdayOf(bad), `${bad} was read as a date`).toBeNull();
    }
  });
});

describe("what a booking submission is allowed to trust", () => {
  it("ACCEPTS ONLY AN INSTANT THAT WAS ACTUALLY OFFERED", () => {
    /*
       The posted time comes from somebody else's machine: the page may be
       stale, or the value edited outright. So the answer comes from
       regenerating availability, never from believing the request.
    */
    const a = ok(ask());
    expect(isOffered(a, "2026-09-07T07:00:00.000Z")).toBe(true);
    // 08:45 local — inside the day, but not on the half hour.
    expect(isOffered(a, "2026-09-07T06:45:00.000Z")).toBe(false);
    // 03:00 local — the middle of the night.
    expect(isOffered(a, "2026-09-07T01:00:00.000Z")).toBe(false);
  });

  it("refuses a time that a booked meeting has since taken", () => {
    const free = ok(ask());
    expect(isOffered(free, "2026-09-07T08:00:00.000Z")).toBe(true);

    const taken = ok(ask({ busy: [{ startsAt: "2026-09-07T08:00:00Z", durationMin: 30 }] }));
    expect(isOffered(taken, "2026-09-07T08:00:00.000Z"), "a taken slot was still bookable").toBe(
      false
    );
  });

  it("accepts the same instant however it was written", () => {
    const a = ok(ask());
    expect(isOffered(a, "2026-09-07T07:00:00Z")).toBe(true);
    expect(isOffered(a, "2026-09-07T09:00:00+02:00")).toBe(true);
  });

  it("refuses nonsense, and refuses everything when hours are unset", () => {
    expect(isOffered(ok(ask()), "whenever")).toBe(false);
    expect(isOffered(ask({ week: [] }), "2026-09-07T07:00:00.000Z")).toBe(false);
  });
});

describe("a request that does not make sense is refused, not guessed at", () => {
  it.each([
    ["fromDate", { fromDate: "7 September" }],
    ["days below one", { days: 0 }],
    ["days beyond the cap", { days: 91 }],
    ["fractional days", { days: 1.5 }],
    ["a meeting of no length", { slotMinutes: 0 }],
    ["a meeting longer than a working day is long", { slotMinutes: 9 * 60 }],
    ["a step of nothing, which would never terminate", { stepMinutes: 0 }],
    ["negative notice", { minNoticeMinutes: -1 }],
    ["a now that is not a moment", { now: new Date("nonsense") }],
  ])("refuses %s", (_what, over) => {
    const a = ask(over as Partial<SlotRequest>);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("bad_request");
  });

  it("terminates on a zero step rather than hanging", () => {
    /* A step of 0 would loop for ever building slots until the process died —
       a denial of service reachable from a query string. Checked before the
       loop, and this test is the proof it cannot be reached. */
    const before = Date.now();
    expect(ask({ stepMinutes: 0 }).ok).toBe(false);
    expect(Date.now() - before).toBeLessThan(1000);
  });
});
