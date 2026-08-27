import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The date and time on the dashboard.
 *
 * They were a 12px uppercase eyebrow on top of "Good evening, Bradley 👋" — a
 * caption on a greeting rather than information in their own right. They are
 * their own panel now, above the welcome card, on every width.
 */

const bar = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/DateTimeBar.tsx", import.meta.url)),
  "utf8"
);
const page = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/page.tsx", import.meta.url)),
  "utf8"
);

describe("the dashboard date and time", () => {
  it("is its own panel, above the greeting, at every width", () => {
    /* One element in the flow rather than a media-query variant, so desktop
       and mobile get the same arrangement — which is what was asked for. */
    expect(page).toMatch(/<DateTimeBar timeZone=\{timeZone\} initialDate=\{dateLabel\} \/>/);

    /* And the greeting card no longer carries them. */
    expect(page).not.toMatch(/LiveClock/);
    expect(page).not.toMatch(/uppercase tracking-\[0\.14em\] text-faint">\s*\n\s*\{date\}/);
  });

  it("counts the day in the business's zone, not the server's", () => {
    /**
     * This was a real disagreement, not just a layout problem. The date was
     * `toLocaleDateString("en-US", …)` with no `timeZone`, which resolves to
     * the SERVER's zone — UTC on Vercel — while "Meetings Today" a few pixels
     * below was already filtered by the business zone. At 01:00 in
     * Johannesburg the page printed yesterday's date beside a count of today's
     * meetings, and both looked authoritative.
     */
    expect(page).toMatch(/timeZone: settings\.timeZone \|\| "UTC"/);
    expect(page).toMatch(/month: "long",\s*\n\s*year: "numeric",\s*\n\s*timeZone,/);
    /* Anchored on the assignment, not the bare call. The comment explaining
       the fix quotes the old code verbatim, so a loose negative match fails
       against the explanation of the very thing it is checking for — the third
       time this session a regex has matched prose instead of code. */
    expect(page).not.toMatch(/const dateLabel = now\.toLocaleDateString\("en-US"/);
  });

  it("formats the clock and its zone label from the same zone", () => {
    /* A label that came from anywhere else could caption a time it does not
       describe — the worst kind of wrong, because it looks precise. */
    const clockZone = /toLocaleTimeString\("en-GB", \{[\s\S]*?timeZone,[\s\S]*?\}\)/.test(bar);
    expect(clockZone).toBe(true);
    expect(bar).toMatch(/new Intl\.DateTimeFormat\("en-GB", \{ timeZone, timeZoneName: "short" \}\)/);
  });

  it("does not call the business's clock the reader's local time", () => {
    /* "Local time" was the first label and it is only true when the viewer and
       the office share a zone. Someone reading from another country would be
       told their own local time and shown the office's. */
    expect(bar).toMatch(/" · Business time"/);
    expect(bar).not.toMatch(/" · Local time"/);
  });

  it("renders nothing live on the server", () => {
    /**
     * The server and the reader can sit in different zones, so a real time
     * during SSR would both mismatch on hydration and briefly show the
     * server's idea of now on a dashboard people read at a glance.
     *
     * The date is different: it is formatted in an explicit zone, so it is
     * deterministic and can be server-rendered — which is why the first paint
     * is already correct rather than blank.
     */
    expect(bar).toMatch(/const getServerSnapshot = \(\): number \| null => null/);
    expect(bar).toMatch(/\?\? initialDate/);
  });

  it("reserves the space the clock will take", () => {
    /* `visibility: hidden` rather than not rendering it: an element that
       appears at hydration shoves everything beside it. */
    expect(bar).toMatch(/visibility: live \? undefined : "hidden"/);
    expect(bar).toMatch(/visibility: zone \? undefined : "hidden"/);
  });

  it("shortens the date rather than truncating it on a phone", () => {
    /* "Wednesday, 27 August 2026" needs ~210px and a 375px phone has ~150px
       here once the icon and clock are placed, so it could only render as
       "Wednesday, 27 Aug…" — a layout that looks broken rather than adapted. */
    expect(bar).toMatch(/min-\[430px\]:hidden">\{dateShort\}/);
    expect(bar).toMatch(/hidden min-\[430px\]:inline">\{dateFull\}/);
  });

  it("takes every colour from a theme token", () => {
    /* The app has three themes and swaps them on a clock. A literal hex here
       would be correct in one of them and wrong in the other two. */
    expect(bar).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(bar).not.toMatch(/rgba?\(/);
  });
});
