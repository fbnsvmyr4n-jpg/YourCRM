import { describe, expect, it } from "vitest";
import { matchPeople, matchStrings, matchRanges, normalise } from "../src/lib/person-search";
import type { Person } from "../src/components/ui/PersonField";

/**
 * Making the suggestions smarter, not just present.
 *
 * Four things a list of names has to do before it feels like it is helping
 * rather than filtering: reach a name typed without its accents, answer the two
 * letters people actually reach for, put what you use most at the top, and say
 * why each row is in the list.
 */

const P = (name: string, company: string, email: string): Person => ({ name, company, email });
const names = (ps: Person[]) => ps.map((p) => p.name);

describe("a name typed the way a keyboard produces it", () => {
  it("finds an accented name from unaccented letters", () => {
    /**
     * A keyboard rarely produces the accent a name is filed under. Matched
     * literally, "jose" finds nobody and the CRM appears not to hold a contact
     * it holds.
     */
    const book = [P("José Müller", "Müller Bau", "jose@mullerbau.de")];
    expect(names(matchPeople(book, "jose"))).toEqual(["José Müller"]);
    expect(names(matchPeople(book, "muller"))).toEqual(["José Müller"]);
  });

  it("works the other way too, so the accented spelling still finds it", () => {
    const book = [P("José Müller", "Müller Bau", "jose@mullerbau.de")];
    expect(names(matchPeople(book, "José"))).toEqual(["José Müller"]);
  });

  it("normalises both sides identically", () => {
    expect(normalise("José MÜLLER")).toBe("jose muller");
  });
});

describe("the two letters people actually reach for", () => {
  const book = [
    P("Amara Dube", "Dube Landscaping", "amara@dubelandscaping.co"),
    P("Ruth Adeyemi", "Adeyemi Law", "ruth@adeyemilaw.co"),
    P("Kobus Steyn", "Steyn Steel", "kobus@steynsteel.co"),
  ];

  it("reaches a full name by its initials", () => {
    expect(names(matchPeople(book, "ad"))).toContain("Amara Dube");
  });

  it("never puts an initials guess above a real spelling", () => {
    /* "ad" starts Ruth's surname, and that is a stronger claim than two
       initials that happen to line up. */
    expect(names(matchPeople(book, "ad"))[0]).toBe("Ruth Adeyemi");
  });

  it("does not read a whole word as initials", () => {
    /* "adeyemi" means the surname. Reading longer queries this way would drag
       half an address book into every search. */
    expect(names(matchPeople(book, "adeyemi"))).toEqual(["Ruth Adeyemi"]);
    expect(names(matchPeople(book, "kobus"))).toEqual(["Kobus Steyn"]);
  });

  it("does not read a multi-word query as initials", () => {
    /**
     * "ad" alone reaches Amara Dube on her initials; "ad" with a second word
     * that matches nothing must reach nobody. Asserted this way because single
     * letters match the text literally — "a d" finds people through the normal
     * all-words rule, so it cannot tell the two paths apart.
     */
    expect(matchPeople(book, "ad zzz")).toEqual([]);
  });

  it("does not read a one-letter query as initials either", () => {
    /* A single letter as "initials" is every name beginning with it, which the
       ordinary prefix rule already handles better. */
    const solo = [P("Amara Dube", "Dube Landscaping", "amara@dubelandscaping.co")];
    expect(names(matchPeople(solo, "a"))).toEqual(["Amara Dube"]);
  });
});

describe("what you use most, not merely last", () => {
  it("puts the standing room above a one-off", () => {
    /**
     * A room used on twenty meetings and a link used once. Handed over newest
     * first, date order alone puts the one-off top purely because it was typed
     * most recently.
     */
    const links = [
      "https://meet.example.com/one-off",
      ...Array.from({ length: 5 }, () => "https://meet.example.com/standing"),
    ];
    expect(matchStrings(links, "")[0]).toBe("https://meet.example.com/standing");
  });

  it("keeps the newer of two used equally often", () => {
    expect(matchStrings(["Newer topic", "Older topic"], "")).toEqual(["Newer topic", "Older topic"]);
  });

  it("still lets a prefix beat a more-used near miss", () => {
    /* What was typed outranks what is popular — otherwise typing narrows to
       the wrong thing and feels broken. */
    const opts = ["Weekly check-in", "Weekly check-in", "Check the roof"];
    expect(matchStrings(opts, "check")[0]).toBe("Check the roof");
  });

  it("counts case- and space-insensitively when deduplicating", () => {
    expect(matchStrings(["Intro call", "intro call", " INTRO CALL "], "")).toEqual(["Intro call"]);
  });
});

describe("saying why a row is in the list", () => {
  it("marks each typed word where it falls", () => {
    expect(matchRanges("Shopfront glazing quote", "glazing")).toEqual([[10, 17]]);
  });

  it("marks every occurrence, not only the first", () => {
    /* A term can appear in both a name and an address, and highlighting one of
       them looks like a near miss. */
    expect(matchRanges("ana@anasilva.co", "ana")).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it("merges overlapping words into one run", () => {
    /* Otherwise a highlight opens inside a highlight and the string is split
       into fragments that no longer read as the original. */
    expect(matchRanges("meeting", "meet meeting")).toEqual([[0, 7]]);
  });

  it("marks the initials when that is what matched", () => {
    /**
     * Without it a contact reached by typing "ad" sits among rows that all show
     * a highlighted "ad" while showing none itself, and reads as an arbitrary
     * extra result rather than the deliberate one it is.
     */
    expect(matchRanges("Amara Dube", "ad")).toEqual([
      [0, 1],
      [6, 7],
    ]);
  });

  it("finds ranges through accents, and reports them against the real text", () => {
    /* The offsets have to index the ORIGINAL string — the accents belong on
       screen even though they were ignored while matching. */
    expect(matchRanges("José Müller", "jose")).toEqual([[0, 4]]);
  });

  it("marks nothing when nothing matched", () => {
    expect(matchRanges("Intro call", "zzz")).toEqual([]);
    expect(matchRanges("Intro call", "")).toEqual([]);
  });
});
