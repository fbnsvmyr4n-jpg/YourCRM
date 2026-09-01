import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchPeople } from "../src/lib/person-search";
import type { Person } from "../src/components/ui/PersonField";

/**
 * Finding the person you meant in the To field.
 *
 * The field matched a single `includes` over the joined name, company and
 * address, and offered nothing at all until the first keystroke. Both are the
 * same failure from the reader's side: to find someone they had to already know
 * how that someone is written down.
 */

const P = (name: string, company: string, email: string): Person => ({ name, company, email });

const book: Person[] = [
  P("Kobus Steyn", "Steyn Steel", "kobus@steynsteel.co"),
  P("Gina Abrahams", "Abrahams Tile", "gina@abrahamstile.co"),
  P("Nadia Farouk", "Farouk Design", "nadia@faroukdesign.co"),
  P("Amara Dube", "Dube Landscaping", "amara@dubelandscaping.co"),
  P("Thandi Molefe", "Molefe Glass", "thandi@molefeglass.co.za"),
  P("Zoe Mbeki", "Mbeki Glass", "zoe@mbekiglass.co"),
];

const names = (ps: Person[]) => ps.map((p) => p.name);

describe("matching who was typed", () => {
  it("finds a person by first name, surname, company or address", () => {
    expect(names(matchPeople(book, "kobus"))).toContain("Kobus Steyn");
    expect(names(matchPeople(book, "steyn"))).toContain("Kobus Steyn");
    expect(names(matchPeople(book, "landscaping"))).toContain("Amara Dube");
    expect(names(matchPeople(book, "faroukdesign.co"))).toContain("Nadia Farouk");
  });

  it("does not care what order the words came in", () => {
    /**
     * The reason this was rewritten. A single `includes` over the joined string
     * only ever matched the order it happened to be stored in: "kobus steyn"
     * found him and "steyn kobus" found nobody — which reads as "he isn't in
     * here" rather than "you typed his name backwards".
     */
    expect(names(matchPeople(book, "kobus steyn"))).toEqual(["Kobus Steyn"]);
    expect(names(matchPeople(book, "steyn kobus"))).toEqual(["Kobus Steyn"]);
  });

  it("narrows as more words are typed, across different fields", () => {
    // "glass" alone reaches two companies; a name with it reaches one.
    expect(names(matchPeople(book, "glass"))).toHaveLength(2);
    expect(names(matchPeople(book, "glass thandi"))).toEqual(["Thandi Molefe"]);
  });

  it("puts a name that starts with the query above one that merely contains it", () => {
    /**
     * Typing "ab" should reach Gina Abrahams before Amara Dube, whose address
     * is the only reason she matches at all. Ranking by WHERE the match falls
     * is what makes a two-letter query usable.
     */
    const hits = names(matchPeople(book, "ab"));
    expect(hits).toContain("Gina Abrahams");
    expect(hits.indexOf("Gina Abrahams")).toBe(0);
  });

  it("reaches someone by surname alone, ahead of an incidental match", () => {
    // "mbeki" starts Zoe's surname and sits mid-string in her own address.
    expect(names(matchPeople(book, "mbeki"))[0]).toBe("Zoe Mbeki");
  });

  it("puts a whole name that starts with the query above a surname that does", () => {
    /**
     * Both of these match at the start of a word, so only the tiers separate
     * them — and they are listed here in the wrong order deliberately, so a
     * ranking that collapsed the two would return them as given.
     */
    const both = [
      P("Zanele Marais", "Marais Plumbing", "zanele@maraisplumbing.co"),
      P("Mara Sithole", "Sithole Roofing", "mara@sitholeroofing.co"),
    ];
    expect(names(matchPeople(both, "mar"))).toEqual(["Mara Sithole", "Zanele Marais"]);
  });

  it("puts a surname start above a word buried in a company name", () => {
    /**
     * Kobus's company and address deliberately do NOT begin with "steyn", so
     * his surname is the only thing lifting him — anything that stopped ranking
     * on it would drop him to a bare contains, level with Piet, who matches
     * only because "steyn" sits mid-way through his employer's name. Listed in
     * the wrong order so that collapsing the two shows up as the wrong order
     * rather than as nothing at all.
     */
    const both = [
      P("Piet Venter", "Van Steyn Holdings", "piet@vansteyn.co"),
      P("Kobus Steyn", "Cape Fabrication", "kobus@capefab.co"),
    ];
    expect(names(matchPeople(both, "steyn"))).toEqual(["Kobus Steyn", "Piet Venter"]);
  });

  it("puts an address that starts with the query above one that merely holds it", () => {
    const both = [
      P("Ana Mokoena", "Old Bright Works", "ana@oldbrightworks.co"),
      P("Lerato Khumalo", "Cape Signage", "bright@capesignage.co"),
    ];
    expect(names(matchPeople(both, "bright"))).toEqual(["Lerato Khumalo", "Ana Mokoena"]);
  });

  it("puts a company that starts with the query above one that merely holds it", () => {
    const both = [
      P("Ana Mokoena", "Old Delta Works", "ana@odw.co"),
      P("Sipho Ndlovu", "Delta Roofing", "sipho@ndlovu.co"),
    ];
    expect(names(matchPeople(both, "delta"))).toEqual(["Sipho Ndlovu", "Ana Mokoena"]);
  });

  it("keeps the order it was given when nothing distinguishes two people", () => {
    /**
     * The inbox hands these over most recently messaged first, so an ambiguous
     * query settles on whoever is actually being corresponded with rather than
     * whoever the database returned first. A sort that did not preserve input
     * order would silently throw that away.
     */
    const glass = [
      P("Thandi Molefe", "Molefe Glass", "thandi@molefeglass.co.za"),
      P("Zoe Mbeki", "Mbeki Glass", "zoe@mbekiglass.co"),
    ];
    expect(names(matchPeople(glass, "glass"))).toEqual(["Thandi Molefe", "Zoe Mbeki"]);
    expect(names(matchPeople([...glass].reverse(), "glass"))).toEqual(["Zoe Mbeki", "Thandi Molefe"]);
  });

  it("suggests nothing for an empty or blank query", () => {
    /* Not "everyone": an unfiltered address book dumped under the field is not
       a suggestion, and what belongs there instead is the recents list. */
    expect(matchPeople(book, "")).toEqual([]);
    expect(matchPeople(book, "   ")).toEqual([]);
  });

  it("returns nothing rather than a near miss", () => {
    expect(matchPeople(book, "zzzznobody")).toEqual([]);
  });

  it("caps the list so it cannot bury the form under itself", () => {
    // One common letter matches most of a real contact book.
    expect(matchPeople(book, "a").length).toBeLessThanOrEqual(6);
    expect(matchPeople(book, "a", 2)).toHaveLength(2);
  });

  it("ignores case on both sides", () => {
    expect(names(matchPeople(book, "KOBUS"))).toEqual(["Kobus Steyn"]);
  });
});

describe("what the field offers before anything is typed", () => {
  const field = readFileSync(
    fileURLToPath(new URL("../src/components/ui/PersonField.tsx", import.meta.url)),
    "utf8"
  );
  const page = readFileSync(
    fileURLToPath(new URL("../src/app/(app)/inbox/page.tsx", import.meta.url)),
    "utf8"
  );

  it("shows the people most recently corresponded with", () => {
    expect(field).toMatch(/const matches = q \? matchPeople\(people, q\) : recent\.slice\(0, 5\)/);
    // Labelled, or an unprompted list of names reads as a result for nothing.
    expect(field).toMatch(/Recent\n/);
  });

  it("opens on its own when the field is focused for the reader", () => {
    /**
     * `autoFocus` focuses during mount and fires no focus event any handler
     * here can see. Left as `useState(false)`, the case that matters most was
     * the one that looked broken: tapping New Email put the cursor in To and
     * offered nothing until the reader tapped the field they were already
     * typing in. Verified in the browser — list absent on open before this,
     * present after.
     */
    expect(field).toMatch(/useState\(Boolean\(autoFocus\)\)/);
  });

  it("ranks the whole address book by real correspondence, not a guess", () => {
    /**
     * The newest message carrying each contact's id, read from the mail already
     * on the page. Nothing invented: a contact with no mail is not proposed as
     * recent, because for them it would not be true.
     */
    expect(page).toMatch(/const lastMessageAt = new Map<string, number>\(\)/);
    expect(page).toMatch(/if \(seen === undefined \|\| at > seen\) lastMessageAt\.set\(m\.contactId, at\)/);
    expect(page).toMatch(/\.filter\(\(\{ at, s \}\) => at !== undefined && s\.email\)/);
  });

  it("does not force a recents list on callers that have no ordering", () => {
    /* The meeting scheduler shares this field and has no correspondence to
       rank by. It passes nothing and behaves as it always did. */
    expect(field).toMatch(/recent = \[\],/);
  });
});
