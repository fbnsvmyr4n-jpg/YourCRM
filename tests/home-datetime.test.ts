import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { utcOffsetLabel } from "@/lib/zoned";

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
    expect(page).toMatch(
      /<DateTimeBar timeZone=\{timeZone\} initialWeekday=\{weekdayLabel\} initialDate=\{dateLabel\} \/>/
    );

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
    expect(page).toMatch(/weekday: "long", timeZone \}/);
    expect(page).toMatch(/month: "long",\s*\n\s*year: "numeric",\s*\n\s*timeZone,/);
    /* Anchored on the assignment, not the bare call. The comment explaining
       the fix quotes the old code verbatim, so a loose negative match fails
       against the explanation of the very thing it is checking for — the third
       time this session a regex has matched prose instead of code. */
    expect(page).not.toMatch(/const dateLabel = now\.toLocaleDateString\("en-US"/);
  });

  it("formats the clock and its offset from the same zone", () => {
    /* A label that came from anywhere else could caption a time it does not
       describe — the worst kind of wrong, because it looks precise. */
    const clockZone = /toLocaleTimeString\("en-GB", \{[\s\S]*?timeZone,[\s\S]*?\}\)/.test(bar);
    expect(clockZone).toBe(true);
    expect(bar).toMatch(/utcOffsetLabel\(timeZone, at\)/);
  });

  it("shows the offset, not a name for the zone", () => {
    /* "Business time" said nothing about where the clock is. The offset is the
       part a reader can act on. */
    expect(bar).not.toMatch(/" · Business time"/);
    expect(bar).not.toMatch(/" · Local time"/);
    expect(bar).toMatch(/\{offset \?\? "UTC\+0"\}/);
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

  it("keeps the seconds subordinate — smaller AND lighter", () => {
    /**
     * Both arrangements were built and looked at. Same size differing only in
     * colour reads as one number with a quieter tail; smaller and lighter reads
     * as a clock with a ticking detail. The second is the one that was chosen
     * after seeing both, so it is the one pinned here.
     *
     * The pairing matters more than either half: at the same weight as the
     * hours the smaller size looks like a rendering fault rather than a
     * decision, so `font-normal` and `text-faint` travel with it.
     */
    expect(bar).toMatch(
      /<span className="text-\[16px\] font-normal text-faint sm:text-\[18px\]">:\{ss\}<\/span>/
    );
  });

  it("carries the clock at a lighter weight than the labels around it", () => {
    /**
     * At display sizes a semibold clock reads as heavy rather than confident:
     * the weight that makes 15px legible is the weight that makes 34px shout.
     * 500 with the tracking pulled in slightly is the treatment a system
     * typeface gets at this size, and it lets the figure grow without
     * dominating the card.
     */
    expect(bar).toMatch(
      /text-\[30px\] font-medium leading-none tabular-nums tracking-\[-0\.02em\] sm:text-\[34px\]/
    );
    /* Larger than the labels, so the size does the ranking that the weight no
       longer does. */
    expect(bar).not.toMatch(/text-\[30px\] font-semibold/);
  });

  it("scales the date to pair with the clock rather than caption it", () => {
    /**
     * At 15px/600 against a 34px/500 clock the left half read as a caption on
     * the figure beside it — two different type sizes with nothing relating
     * them across a divider. The date now takes the clock's treatment one step
     * down: same weight, same negative tracking, 22/26px against 30/34.
     *
     * Deliberately NOT the same size. Two 34px figures either side of a
     * hairline would read as a split card with no subject, so the ranking is
     * carried by size once the weight is shared.
     */
    expect(bar).toMatch(
      /text-\[22px\] font-medium leading-none tracking-\[-0\.02em\] sm:text-\[26px\]/
    );
    expect(bar).not.toMatch(/text-\[15px\] font-semibold tracking-tight/);

    /* Shared weight, so nothing but size separates them. Measured: date 26px
       w500, clock 34px w500 at 1280px. */
    const weights = bar.match(/font-(medium|semibold|normal|bold)/g) ?? [];
    expect(weights.filter((w) => w === "font-medium")).toHaveLength(2);
  });

  it("puts the offset under the clock, right-aligned with it", () => {
    /**
     * Tried both. Beside the weekday it left the clock uncontested; under the
     * clock it groups the two facts about the same instant and keeps the left
     * column purely calendar. The second was chosen after seeing both.
     *
     * Asserted structurally — the offset must sit inside the right-hand,
     * right-aligned block — because checking only that both strings exist would
     * pass with the offset anywhere on the card, including the arrangement this
     * replaced.
     */
    const rightBlock = bar.match(/<div className="text-right">([\s\S]*?)<\/div>/)?.[1];
    expect(rightBlock).toBeDefined();
    expect(rightBlock).toMatch(/\{hhmm\}/);
    expect(rightBlock).toMatch(/\{offset \?\? "UTC\+0"\}/);

    /* And the weekday line is calendar only. */
    const eyebrow = bar.match(/uppercase tracking-\[0\.16em\] text-faint">([\s\S]*?)<\/p>/)?.[1];
    expect(eyebrow).toMatch(/\{weekday\}/);
    expect(eyebrow).not.toMatch(/offset/);
  });

  it("reserves the space the clock will take", () => {
    /* `visibility: hidden` rather than not rendering it: an element that
       appears at hydration shoves everything beside it. */
    expect(bar).toMatch(/visibility: live \? undefined : "hidden"/);
    expect(bar).toMatch(/visibility: offset \? undefined : "hidden"/);
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

describe("the UTC offset label", () => {
  /* A fixed instant in northern summer, so the two hemispheres' DST states are
     both exercised by the zones below. */
  const JULY = new Date("2026-07-15T12:00:00Z");
  const JANUARY = new Date("2026-01-15T12:00:00Z");

  it("states an offset for every zone, including UTC itself", () => {
    /* UTC comes back from Intl as a bare "GMT" with no sign. Left alone it
       would be the one zone in the world that does not state an offset. */
    expect(utcOffsetLabel("UTC", JULY)).toBe("UTC+0");
    expect(utcOffsetLabel("Africa/Johannesburg", JULY)).toBe("UTC+2");
    expect(utcOffsetLabel("America/New_York", JULY)).toBe("UTC-4");
  });

  it("keeps the zones that are not whole hours from UTC", () => {
    /**
     * The reason this is derived from Intl rather than computed. India is
     * +5:30 and the Chatham Islands are +12:45; anything dividing a millisecond
     * offset by 3600000 rounds both into an offset nobody lives in.
     */
    expect(utcOffsetLabel("Asia/Kolkata", JULY)).toBe("UTC+5:30");
    expect(utcOffsetLabel("Pacific/Chatham", JULY)).toBe("UTC+12:45");
  });

  it("moves with daylight saving, so it needs the instant", () => {
    /* London is +0 in January and +1 in July. A label computed once at module
       load would be wrong for half the year. */
    expect(utcOffsetLabel("Europe/London", JANUARY)).toBe("UTC+0");
    expect(utcOffsetLabel("Europe/London", JULY)).toBe("UTC+1");

    /* Southern hemisphere runs the other way. */
    expect(utcOffsetLabel("Australia/Sydney", JANUARY)).toBe("UTC+11");
    expect(utcOffsetLabel("Australia/Sydney", JULY)).toBe("UTC+10");
  });

  it("never uses the zone's common name in place of its offset", () => {
    /* `timeZoneName: "short"` returns "BST" for London in July and "SAST" for
       Johannesburg — an abbreviation, not an offset. */
    expect(utcOffsetLabel("Europe/London", JULY)).not.toMatch(/BST/);
    expect(utcOffsetLabel("Africa/Johannesburg", JULY)).not.toMatch(/SAST/);
  });

  it("returns null for an unknown zone rather than throwing", () => {
    /* Intl throws on a bad zone, and a label is not worth taking the page down
       for. */
    expect(utcOffsetLabel("Not/AZone", JULY)).toBeNull();
  });
});
