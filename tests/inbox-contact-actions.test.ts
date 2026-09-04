import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The actions on a sender's card.
 *
 * Reported as not working to the standard of the rest of the app, and two of
 * them genuinely were not:
 *
 *   Note    → /contacts?open=<id>
 *   Contact → /contacts?open=<id>
 *
 * The same destination. Two of six buttons did the identical thing, and the one
 * labelled "Note" did not take a note — it moved you to another screen to go and
 * find the real one. "Revenue" opened the whole deals board, which is every
 * deal in the business rather than this person's revenue.
 *
 * Both now answer where they were asked.
 */

const view = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/inbox/InboxView.tsx", import.meta.url)),
  "utf8"
);
const page = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/inbox/page.tsx", import.meta.url)),
  "utf8"
);

describe("Note takes a note", () => {
  it("no longer sends you to the contact record to find one", () => {
    /* The tell was that two hrefs matched. Only the last button — the one
       reported as working — should navigate to the record. */
    const toRecord = [...view.matchAll(/\/contacts\?open=\$\{contactId\}/g)];
    expect(toRecord, "more than one action still navigates to the contact").toHaveLength(2);
    /* One in the Contact action, one in the Revenue panel's "Open contact"
       link — neither of them the Note. */
    expect(view).not.toMatch(/label: "Note",[\s\S]{0,200}?href:/);
  });

  it("writes through the same action the contact page uses", () => {
    /* Not a second way to store a note. One writer means one shape of record,
       and the note lands on the timeline the contact page already renders. */
    expect(view).toMatch(/import \{ addNoteAction \} from "@\/app\/\(app\)\/contacts\/actions";/);
    expect(view).toMatch(/await addNoteAction\(contactId, formData\);/);
  });

  it("says what happened, because the note lands on another screen", () => {
    /* The timeline it joins is not visible from here, so without a word the
       only feedback would be the box emptying. */
    expect(view).toMatch(/setNoteSaved\(true\)/);
    expect(view).toMatch(/noteSaved \? "Saved to their timeline\." : "Saved against this contact\."/);
  });
});

describe("Revenue means this contact's revenue", () => {
  it("does not open the whole deals board", () => {
    expect(view).not.toMatch(/label: "Revenue",[\s\S]{0,120}?href: contactId \? "\/deals"/);
  });

  it("is computed from the same source the contacts page uses", () => {
    /* So the two screens cannot disagree about what a person is worth. */
    expect(page).toMatch(/import \{ contactSummaries \} from "@\/server\/contact-summaries";/);
    expect(page).toMatch(/wonValueCents \/ 100/);
    expect(page).toMatch(/openValueCents \/ 100/);
  });

  it("asks only for the senders on screen", () => {
    /* One query for ids the list already resolved, not a scan of every
       contact in the account. */
    expect(page).toMatch(/const contactIds = \[\.\.\.new Set\(Object\.values\(contactFor\)\)\]\.filter\(Boolean\);/);
    expect(page).toMatch(/contactIds\.length \? await contactSummaries\(q, contactIds\) : \{\}/);
  });

  it("says what the figures cover rather than leaving two numbers floating", () => {
    expect(view).toMatch(/Across \$\{revenue\.deals\} deal/);
    expect(view).toMatch(/No deals recorded against this contact yet\./);
  });
});

describe("the pair behave like one control", () => {
  it("only one panel is open at a time", () => {
    /* Two stacked panels in a narrow side card would push the contact details
       off the bottom, and the second would look like a bug. */
    expect(view).toMatch(/useState<"revenue" \| "note" \| null>\(null\)/);
    expect(view).toMatch(/setPanel\(\(p\) => \(p === "revenue" \? null : "revenue"\)\)/);
    expect(view).toMatch(/setPanel\(\(p\) => \(p === "note" \? null : "note"\)\)/);
  });

  it("tells a screen reader they toggle something", () => {
    expect(view).toMatch(/aria-expanded=\{open\}/);
  });

  it("stays disabled for a sender who is not a contact", () => {
    /* There is nothing to attach a note or a deal to. The button says why
       rather than failing after the tap. */
    expect(view).toMatch(/onClick: contactId \? \(\) => setPanel/);
    expect(view).toMatch(/"Not in your contacts yet"/);
  });
});
