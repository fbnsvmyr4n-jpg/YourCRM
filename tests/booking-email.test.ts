import { describe, expect, it } from "vitest";
import { bookingEmail } from "../src/server/email";

/**
 * The confirmation a visitor receives.
 *
 * The only email in this product sent to somebody who has never signed in, and
 * the one most likely to cross a time zone. So it is read for the two things
 * that go wrong: an ambiguous time, and something from a stranger rendered as
 * markup.
 */

const base = {
  name: "Amara Dube",
  topic: "Site visit",
  scheduledAt: "2026-09-07T07:00:00.000Z",
  durationMin: 30,
  kind: "in_person" as const,
  workspace: "Acme Cranes",
  timeZone: "Africa/Johannesburg",
};

describe("the time in a booking confirmation", () => {
  it("is written in the BUSINESS's zone, and names the zone", () => {
    const { text, subject } = bookingEmail(base);
    // 07:00Z is 09:00 in Johannesburg.
    expect(text).toMatch(/09:00/);
    expect(text).toMatch(/UTC\+2/);
    expect(subject).toMatch(/09:00/);
    expect(text, "the UTC instant leaked into the email").not.toMatch(/07:00/);
  });

  it("moves with the zone rather than with the server", () => {
    const ny = bookingEmail({ ...base, timeZone: "America/New_York" });
    expect(ny.text).toMatch(/03:00/);
    expect(ny.text).toMatch(/UTC-4/);
  });

  it("still says something unambiguous for a zone it cannot read", () => {
    const { text } = bookingEmail({ ...base, timeZone: "Mars/Olympus_Mons" });
    expect(text).toMatch(/\(UTC\)/);
  });
});

describe("what a stranger typed", () => {
  it("is never rendered as markup", () => {
    const { html } = bookingEmail({
      ...base,
      name: `<img src=x onerror=alert(1)>`,
      topic: `<script>steal()</script>`,
      workspace: `A&B "Cranes"`,
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("A&amp;B &quot;Cranes&quot;");
  });

  it("carries the appointment and nothing else about the workspace", () => {
    const { text } = bookingEmail(base);
    for (const expected of ["Acme Cranes", "Site visit", "30 minutes", "In person"]) {
      expect(text).toContain(expected);
    }
  });
});
