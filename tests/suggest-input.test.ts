import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchStrings } from "../src/lib/person-search";

/**
 * The three free-text boxes on the meeting form.
 *
 * Topic, participant email and meeting link were three empty inputs, and all
 * three are nearly always a repeat: a topic recurs across a week of follow-ups,
 * the link is usually the one standing room, and the address belongs to
 * somebody already on file. Retyping a conferencing URL from memory is the
 * worst of them — long, exact, and getting it wrong produces a meeting nobody
 * can join.
 */

const view = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/meetings/MeetingsView.tsx", import.meta.url)),
  "utf8"
);
const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const input = readFileSync(
  fileURLToPath(new URL("../src/components/ui/SuggestInput.tsx", import.meta.url)),
  "utf8"
);

const topics = [
  "Follow-up on the roofing proposal",
  "Intro call",
  "Shopfront glazing quote walkthrough",
  "Site survey",
];

describe("suggesting from what has been typed before", () => {
  it("offers the list as it stands before anything is typed", () => {
    /* "What did I use last time" is the whole question for these fields, so an
       empty box is exactly when the answer is most useful. */
    expect(matchStrings(topics, "")).toEqual(topics);
    expect(matchStrings(topics, "   ")).toEqual(topics);
  });

  it("narrows on any word, not just the first", () => {
    expect(matchStrings(topics, "roofing")).toEqual(["Follow-up on the roofing proposal"]);
    expect(matchStrings(topics, "quote glazing")).toEqual(["Shopfront glazing quote walkthrough"]);
  });

  it("requires every word, so more typing means fewer answers", () => {
    /**
     * Words drawn from two different topics must match neither. Matching on ANY
     * word would widen the list as the reader typed — the opposite of what
     * typing more is for — and both of these pass the looser rule, which is why
     * the earlier two-word case did not catch it.
     */
    expect(matchStrings(topics, "intro survey")).toEqual([]);
    expect(matchStrings(topics, "intro roofing")).toEqual([]);
  });

  it("puts a value that starts with the query above one that contains it", () => {
    /* "site" should reach "Site survey" before a topic that merely mentions a
       site halfway through. */
    const opts = ["Revisit the site after the survey", "Site survey"];
    expect(matchStrings(opts, "site")[0]).toBe("Site survey");
  });

  it("says each thing once, however often it was used", () => {
    /* A weekly stand-up is one suggestion, not fifty — and the same link used
       on every meeting should not fill the list with itself. */
    const repeated = ["Intro call", "intro call", "  Intro call  ", "Site survey"];
    expect(matchStrings(repeated, "")).toEqual(["Intro call", "Site survey"]);
  });

  it("ignores case on both sides", () => {
    expect(matchStrings(topics, "INTRO")).toEqual(["Intro call"]);
  });

  it("offers nothing rather than a near miss", () => {
    expect(matchStrings(topics, "zzzznothing")).toEqual([]);
  });

  it("offers nothing at all on an account with no history", () => {
    /* An empty history must not fall back to examples somebody could mistake
       for their own records. */
    expect(matchStrings([], "")).toEqual([]);
    expect(matchStrings(["", "   "], "")).toEqual([]);
  });

  it("caps the list so it cannot bury the form under itself", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Topic ${i}`);
    expect(matchStrings(many, "").length).toBeLessThanOrEqual(6);
    expect(matchStrings(many, "Topic", 3)).toHaveLength(3);
  });
});

describe("the field it feeds", () => {
  it("suggests without ever becoming a gate", () => {
    /* Anything can still be typed; a value matching nothing is simply new. */
    expect(input).toMatch(/onChange=\{\(e\) => \{\s*\n\s*onChange\(e\.target\.value\)/);
    expect(input).not.toMatch(/readOnly/);
  });

  it("keeps the caret in the field when a suggestion is pressed", () => {
    /* Without it the press blurs the input first, iOS starts closing the
       keyboard, and the page reflows out from under the tap. Verified: picking
       "Intro call" filled the box, closed the list and kept focus. */
    expect(input).toMatch(/onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/);
  });

  it("belongs to the field rather than floating near it", () => {
    /**
     * Positioned by CSS against the field, not by JavaScript against the
     * viewport. Three JS attempts each fixed one device and failed on another;
     * on a real iPhone the list ended up 118px from its own box. The card these
     * fields live in does not clip, so nothing was gained by portalling them.
     */
    expect(input).not.toMatch(/createPortal/);
    expect(input).toMatch(/popover absolute left-0 right-0/);
    expect(input).toMatch(/useDropDirection\(anchor, listOpen\)/);
  });

  it("cannot select past the end of a list that just narrowed", () => {
    expect(input).toMatch(/const active = Math\.min\(highlight, Math\.max\(0, matches\.length - 1\)\)/);
  });
});

describe("what the meeting form suggests from", () => {
  it("reads the history off the meetings already on the page", () => {
    /* No new query, and nothing invented. */
    expect(code).toMatch(/topics: byNewest\.map\(\(m\) => m\.topic\)/);
    expect(code).toMatch(/links: byNewest\.map\(\(m\) => m\.link\)/);
    expect(code).toMatch(/emails: addressablePeople\(people\)\.map/);
  });

  it("offers the newest first", () => {
    /* The useful answer to "what do I put here" is almost always the last one. */
    expect(code).toMatch(/\.sort\(\(a, b\) => \(b\.date \?\? ""\)\.localeCompare\(a\.date \?\? ""\)\)/);
  });

  it("only offers addresses that could actually receive a change notice", () => {
    expect(code).toMatch(/emails: addressablePeople\(people\)/);
  });

  it("wires all three text boxes and the contact field", () => {
    expect(code).toMatch(/options=\{history\.topics\}/);
    expect(code).toMatch(/options=\{history\.emails\}/);
    expect(code).toMatch(/options=\{history\.links\}/);
    expect(code).toMatch(/recent=\{history\.recent\}/);
    /* And none of them is a bare input any more. */
    expect(code).not.toMatch(/placeholder="Meeting topic \(optional\)"\s*\n\s*className="field-input"/);
  });
});

describe("who the scheduler is allowed to know about", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../src/app/(app)/meetings/page.tsx", import.meta.url)),
    "utf8"
  );

  it("suggests from the contact book, not from past meetings", () => {
    /**
     * The people list was derived from the meetings themselves, so the
     * scheduler only ever knew people who had ALREADY been met — the one set
     * you are least likely to be booking for the first time. On an account with
     * no meetings it was empty, and every suggestion on the form silently
     * offered nothing: no contact, no address, no history. That reads exactly
     * like a feature that was never shipped, which is how it was reported.
     *
     * My own testing missed it because the database I tested against had
     * meetings in it, which is precisely the case where the bug is invisible.
     *
     * Verified after: typing "a" reaches Amara Dube, Gina Abrahams and Ruth
     * Adeyemi — none of whom has ever had a meeting — and the address list went
     * from 4 to 16.
     */
    expect(page).toMatch(/addressBook: contacts\.map\(/);
    expect(page).toMatch(/people=\{addressBook\}/);
    expect(page).not.toMatch(/people=\{meetings\.map/);
  });

  it("carries the company a contact actually stores", () => {
    /* Contacts keep it under `info`; the suggestion list reads `company`, and a
       mismatch would show every contact with a blank second line. */
    expect(page).toMatch(/company: c\.info \?\? ""/);
  });
});
