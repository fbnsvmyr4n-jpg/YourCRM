import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addressablePeople, type Person } from "../src/components/ui/PersonField";

/**
 * Forwarding suggests who to forward to.
 *
 * The composer has offered suggestions since it was built — the CRM holds every
 * contact and lead, so typing a recipient from memory was never the right ask.
 * Forward was written before that and kept a bare `<input name="to">`, so the
 * one place you address a message to someone OTHER than the sender was the one
 * place with no help doing it.
 *
 * The cost is not just typing. A mistyped address fails silently: the forward
 * posts, the message files under a recipient nobody has, and nothing says so.
 * Picking from the list instead attaches the real contact record — verified in
 * the browser, a forward addressed by suggestion came back filed against Kobus
 * Steyn rather than a loose string.
 */

const view = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/inbox/InboxView.tsx", import.meta.url)),
  "utf8"
);
/* Comments in this file discuss the bare input it replaced by name, so an
   absence check run against the prose would pass while the input was still
   there. */
const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const field = readFileSync(
  fileURLToPath(new URL("../src/components/ui/PersonField.tsx", import.meta.url)),
  "utf8"
);

/** The Reader's forward form, anchored to its own closing tag. */
const forwardForm = (() => {
  const at = code.indexOf('{mode === "forward" && (');
  expect(at).toBeGreaterThanOrEqual(0);
  const end = code.indexOf("\n            )}", at);
  expect(end).toBeGreaterThan(at);
  return code.slice(at, end);
})();

describe("the forward field suggests people", () => {
  it("uses the same field the composer uses, not a bare text box", () => {
    expect(forwardForm).toMatch(/<PersonField/);
    expect(forwardForm).not.toMatch(/<input name="to"/);
  });

  it("offers only people who can actually receive a message", () => {
    /* A lead captured from a phone call often has no email address. Suggesting
       one produces a forward that cannot arrive, and the reader has no way to
       tell that from a working one. */
    expect(forwardForm).toMatch(/people=\{addressable\}/);
    expect(code).toMatch(/const addressable = useMemo\(\(\) => addressablePeople\(people\), \[people\]\)/);
  });

  it("derives that list in one place for both fields", () => {
    /**
     * The composer and forward both address a message. Two copies of the filter
     * is how one of them starts offering people the other refuses to — this
     * codebase has already paid for that once with two 12-hour time parsers.
     */
    /**
     * Run, not read. Asserting the export exists says nothing about what it
     * does — a body gutted to `return people` passes that check and quietly
     * puts every unreachable lead back in both fields.
     */
    const people: Person[] = [
      { name: "Kobus Steyn", company: "Steyn Steel", email: "kobus@steynsteel.co" },
      { name: "Called-in Lead", company: "", email: "" },
      { name: "Half Entered", company: "Somewhere", email: "not-an-address" },
    ];
    expect(addressablePeople(people).map((p) => p.name)).toEqual(["Kobus Steyn"]);

    expect(field).toMatch(/export function addressablePeople/);
    const uses = code.match(/addressablePeople\(people\)/g) ?? [];
    expect(uses).toHaveLength(2);
    /* And neither call site keeps its own copy of the predicate. */
    expect(code).not.toMatch(/people\.filter\(\(p\) => p\.email/);
  });

  it("fills in the address when someone is picked", () => {
    // The point of the suggestion: the reader chooses a person, not a string.
    expect(forwardForm).toMatch(/onPick=\{\(p\) => setForwardTo\(p\.email\)\}/);
    expect(forwardForm).toMatch(/describe=\{\(p\) => p\.email\}/);
  });

  it("still accepts an address for someone not on file", () => {
    /* A field meant to help must not become a gate. The value is whatever has
       been typed, and only the hidden input is submitted — picking is an
       accelerator, never a requirement. */
    expect(forwardForm).toMatch(/value=\{forwardTo\}/);
    expect(forwardForm).toMatch(/onChange=\{setForwardTo\}/);
    expect(forwardForm).toMatch(/<input type="hidden" name="to" value=\{forwardTo\} \/>/);
  });

  it("guards the empty recipient the hidden input can no longer guard", () => {
    /**
     * `required` does nothing on a hidden input — the browser skips validation
     * for controls it does not display. Swapping the visible input for one
     * meant dropping `required` with it, so the button has to carry the guard,
     * exactly as the composer's does.
     *
     * Left off, a forward with an empty To posts and files under a recipient
     * nobody typed.
     */
    expect(code).toMatch(/disabled=\{sending \|\| \(mode === "forward" && !forwardTo\.trim\(\)\)\}/);
  });

  it("gives the reader the people to suggest from", () => {
    // The Reader had no reason to know about contacts before this.
    expect(code).toMatch(/function Reader\(\{[\s\S]{0,120}?people,/);
    expect(code).toMatch(/people: Person\[\];/);
    expect(code).toMatch(/message=\{selected\}\s*\n\s*people=\{people\}/);
  });
});

describe("the shared field it now uses", () => {
  it("matches on name, company and email", () => {
    /**
     * Verified in the browser against real records: "steyn" found Kobus Steyn
     * by surname, "landscap" found Amara Dube by her company, and "glass" found
     * two people by theirs.
     *
     * The matching itself moved into `matchPeople`, which is pure and is tested
     * on its behaviour in person-search.test.ts. Asserted here only that this
     * field still goes through it — a field that stopped calling it would pass
     * every check made against the matcher alone.
     */
    expect(field).toMatch(/matchPeople\(people, q\)/);
  });

  it("can be driven from the keyboard", () => {
    // Verified: ArrowDown then Enter filled the address and closed the list.
    expect(field).toMatch(/e\.key === "ArrowDown"/);
    expect(field).toMatch(/e\.key === "Enter"/);
    expect(field).toMatch(/e\.key === "Escape"/);
  });

  it("suggests nothing until something has been typed", () => {
    /* An empty query returning every contact turns focusing the field into a
       wall of names over the message being forwarded. */
    expect(field).toMatch(/const matches = q\s*\?/);
  });
});

describe("the suggestion list escapes what would slice it", () => {
  const hook = readFileSync(
    fileURLToPath(new URL("../src/lib/use-anchored-position.ts", import.meta.url)),
    "utf8"
  );
  const menu = readFileSync(
    fileURLToPath(new URL("../src/components/ui/AnchoredMenu.tsx", import.meta.url)),
    "utf8"
  );

  it("renders at <body> rather than inside the scrolling reader", () => {
    /**
     * Written `absolute`, the list was clipped by the reader's own scrolling
     * body. Measured at 393x850 with six matches: the list ran from y=735 to
     * y=1001 against a clipper ending at 962 and a screen ending at 850 — two
     * rows reachable out of six.
     *
     * This is the same defect as the sort and filter menus, in the feature
     * built to fix them, which is why the arithmetic is now shared rather than
     * written a second time.
     */
    expect(field).toMatch(/createPortal\(/);
    /* The class is built with `clsx` now, so the animation can differ by which
       way the list opened — matched on the fixed positioning it must keep. */
    expect(field).toMatch(/"popover fixed z-\[61\]/);
    expect(field).not.toMatch(/popover absolute/);
  });

  it("sizes and places itself from the one shared calculation", () => {
    expect(field).toMatch(/useAnchoredPosition\(anchor, listOpen, \{ align: "start" \}\)/);
    expect(menu).toMatch(/useAnchoredPosition\(anchor, open, \{ width, align: "end" \}\)/);
    /* And neither component keeps its own copy of the clamp. */
    expect(field).not.toMatch(/window\.innerWidth - /);
    expect(menu).not.toMatch(/window\.innerWidth - /);
  });

  it("stays inside the screen and flips up when there is no room below", () => {
    // Verified in the reader on a phone: with the field at y=685 the list
    // opened upward, ending 8px above it, entirely on screen.
    expect(hook).toMatch(/const flip = below < 160 && above > below/);
    expect(hook).toMatch(/Math\.min\(left, window\.innerWidth - w - margin\)/);
    expect(hook).toMatch(/Math\.max\(margin, left\)/);
  });

  it("matches the field it belongs to rather than a fixed width", () => {
    // Measured: same left edge, same width, to the pixel.
    expect(hook).toMatch(/const w = width \?\? r\.width/);
    expect(hook).toMatch(/left = align === "end" \? r\.right - w : r\.left/);
  });

  it("follows its field on scroll instead of closing", () => {
    /**
     * A menu can close on scroll; a field cannot. iOS scrolls the page to
     * reveal an input the moment the keyboard opens, so closing there would
     * shut the list at the exact moment it was wanted.
     */
    expect(hook).toMatch(/addEventListener\("scroll", place, true\)/);
    expect(hook).toMatch(/removeEventListener\("scroll", place, true\)/);
  });

  it("still counts a click on a suggestion as inside the field", () => {
    /**
     * Portalling moved the list out of the wrapper the click-away checks. Left
     * alone, mousedown on a suggestion reads as a click outside: the list
     * closes, the button unmounts, and the click never lands — the pick
     * silently does nothing.
     *
     * Verified with a real mousedown/mouseup/click sequence at the row's own
     * coordinates, which filled the address and closed the list.
     */
    expect(field).toMatch(/const inList = listRef\.current\?\.contains\(target\)/);
    expect(field).toMatch(/if \(!inField && !inList\) setOpen\(false\)/);
  });
});
