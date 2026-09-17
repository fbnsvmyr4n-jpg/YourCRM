import { describe, expect, it } from "vitest";
import { meetingDetail } from "@/server/contact-summaries";

/**
 * What a meeting says under it on a contact's timeline.
 *
 * "scheduled" is the state a meeting is in both before it happens and after it
 * happens without anybody writing it up. Only the second is a gap in the
 * record, and the line used to call both of them "Outcome not recorded" — so a
 * meeting three days out read as paperwork somebody had already missed.
 * Found on 18 Sep 2026 driving a contact card against the dev fixture.
 */

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const at = (iso: string) => new Date(iso);

describe("a meeting on the timeline", () => {
  it("A MEETING STILL TO COME IS SCHEDULED — not a write-up somebody missed", () => {
    expect(meetingDetail("scheduled", at("2026-09-20T09:00:00.000Z"), NOW)).toBe("Scheduled");
  });

  it("says the outcome is missing once the meeting has been and gone", () => {
    expect(meetingDetail("scheduled", at("2026-09-15T09:00:00.000Z"), NOW)).toBe("Outcome not recorded");
  });

  it("shows a recorded outcome as it stands, never overwritten by the clock", () => {
    expect(meetingDetail("held", at("2026-09-15T09:00:00.000Z"), NOW)).toBe("held");
    expect(meetingDetail("no_show", at("2026-09-20T09:00:00.000Z"), NOW)).toBe("no-show");
  });

  it("treats a date it cannot read as past, rather than promising a meeting", () => {
    expect(meetingDetail("scheduled", "not a date", NOW)).toBe("Outcome not recorded");
  });
});
