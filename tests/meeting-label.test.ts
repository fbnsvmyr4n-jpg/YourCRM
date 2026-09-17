import { describe, expect, it } from "vitest";
import { decorateMeeting } from "../src/server/decorate-meeting";
import type { MeetingRecord } from "../src/server/repos/meetings";

/**
 * What a meeting is called on screen.
 *
 * Anything past used to be labelled "Today" so it would stay visible. It did
 * stay visible, and it lied: a meeting from two days ago sat under "Today"
 * while Home said — correctly — that there were no meetings today. Found on
 * 18 Sep 2026 by driving the app against a fixture with one past meeting.
 */

const TODAY = "2026-09-17";
const at = (day: string, time = "10:00") => `${day}T${time}:00.000Z`;

const meeting = (scheduledAt: string): MeetingRecord =>
  ({
    id: "mt_1",
    contactId: null,
    dealId: null,
    ownerUserId: null,
    topic: "Site visit",
    scheduledAt,
    durationMin: 30,
    kind: "online",
    joinUrl: null,
    notes: null,
    outcome: "scheduled",
    lossReason: null,
    createdAt: scheduledAt,
    updatedAt: scheduledAt,
    deletedAt: null,
  }) as unknown as MeetingRecord;

const labelFor = (day: string) => decorateMeeting(meeting(at(day)), [], "UTC", TODAY).when;

describe("when a meeting says it is", () => {
  it("A MEETING WHOSE DAY HAS GONE SAYS SO — it does not claim to be today", () => {
    expect(labelFor("2026-09-15")).toBe("Past");
    expect(labelFor("2026-09-16")).toBe("Past");
  });

  it("today is today, tomorrow is tomorrow, and further out is this week", () => {
    expect(labelFor("2026-09-17")).toBe("Today");
    expect(labelFor("2026-09-18")).toBe("Tomorrow");
    expect(labelFor("2026-09-20")).toBe("This Week");
  });

  it("a past meeting is still carried, with its real date — it must not vanish", () => {
    const shown = decorateMeeting(meeting(at("2026-09-15", "14:30")), [], "UTC", TODAY);
    expect(shown.date).toBe("2026-09-15");
    expect(shown.time).not.toBe("");
  });
});
