/*
   Reading a supplier's price list out of whatever they sent.

   This is the first slice of what Bradley asked for: "we shall get the list
   from the suppliers and then have them send the docs through … a way users can
   just coppy and paste or drag and drop". Nobody retypes forty rows, and a
   product that asks them to is a product quoting last year's prices.

   Every amount here is a real shape a supplier writes. The parser is pure on
   purpose — no database, no tenant — so these can be thrown at it by the dozen,
   and so "why did it read 1,800 as the price" is a question with an answer you
   can sit down and check.

   THE RULE UNDER TEST THROUGHOUT: a line it cannot read is reported, never
   skipped. A row silently dropped from a price list is a rate somebody quotes
   from memory next month.
*/
import { describe, expect, it } from "vitest";
import {
  describeChanges,
  parsePriceList,
  planChanges,
  readAmount,
  type ExistingItem,
} from "@/server/price-import";

describe("reading an amount", () => {
  it("reads the shapes suppliers actually write", () => {
    expect(readAmount("450")).toBe(45000);
    expect(readAmount("450.00")).toBe(45000);
    expect(readAmount("R450")).toBe(45000);
    expect(readAmount("R 450,00")).toBe(45000);
    expect(readAmount("1,800.00")).toBe(180000);
    expect(readAmount("1 800,00")).toBe(180000);
    expect(readAmount("1.800,00")).toBe(180000);
    expect(readAmount("12.50")).toBe(1250);
  });

  it("knows a thousands separator from a decimal point by WHICH COMES LAST", () => {
    /* "1,800.00" and "1.800,00" are both eighteen hundred, and the only thing
       telling them apart is which mark is nearer the end. Getting this
       backwards prices a day of labour at one rand eighty. */
    expect(readAmount("1,800.00")).toBe(readAmount("1.800,00"));
    expect(readAmount("2.500")).toBe(250000);
    expect(readAmount("2,500")).toBe(250000);
  });

  it("refuses what is not money", () => {
    expect(readAmount("")).toBeNull();
    expect(readAmount("each")).toBeNull();
    expect(readAmount("m²")).toBeNull();
    expect(readAmount("-")).toBeNull();
    /* A misread column, not a price. */
    expect(readAmount("999999999")).toBeNull();
    /* Four decimal places is not currency. */
    expect(readAmount("1.23456")).toBeNull();
  });
});

describe("a list pasted out of a spreadsheet", () => {
  it("reads tab-separated rows", () => {
    const { lines, unread } = parsePriceList(
      ["Paving stone 50mm\tm²\t450.00", "Site labour\tday\t1,800.00"].join("\n")
    );
    expect(unread).toEqual([]);
    expect(lines).toMatchObject([
      { name: "Paving stone 50mm", unit: "m²", unitCents: 45000 },
      { name: "Site labour", unit: "day", unitCents: 180000 },
    ]);
  });
});

describe("a list pasted out of a PDF", () => {
  it("reads columns separated by runs of spaces", () => {
    const { lines, unread } = parsePriceList(
      ["Paving stone 50mm     m²      450.00", "Site labour           day     1 800,00"].join("\n")
    );
    expect(unread).toEqual([]);
    expect(lines.map((l) => l.unitCents)).toEqual([45000, 180000]);
  });

  it("does NOT split a name on single spaces", () => {
    /* "Paving stone 50mm" is one field. Splitting on a single space would make
       every product name three columns and price the paving at 50mm. */
    const { lines } = parsePriceList("Paving stone 50mm\tm²\t450.00");
    expect(lines[0].name).toBe("Paving stone 50mm");
  });

  it("takes the LAST number as the price, not the first", () => {
    /* A name can contain a number — "Rebar Y12", "Stone 50mm". Reading left to
       right would price the rebar at twelve. */
    const { lines } = parsePriceList("Rebar Y12\tton\t14,500.00");
    expect(lines[0]).toMatchObject({ name: "Rebar Y12", unitCents: 1450000 });
  });
});

describe("a list whose columns collapsed to single spaces", () => {
  /*
     What plain-text email does to a table, and the bug it exposed.

     Pasting this list into the real screen loaded REBAR AT R500 A TON instead
     of R14,500. The line had no tabs and no double spaces, so the parser fell
     through to splitting on commas — and "14,500.00" split into "14" and
     "500.00". A plausible name, a plausible price, no warning, and every
     quotation built on it out by fourteen thousand rand a ton.

     Found by driving the screen rather than by reading the code, which is the
     third time that has been the difference on this project.
  */
  const COLLAPSED = [
    "Paving stone m² 480.00",
    "Site labour day 1 800,00",
    "Rebar Y12 ton 14,500.00",
  ].join("\n");

  it("DOES NOT SPLIT A THOUSANDS SEPARATOR INTO A COLUMN", () => {
    const { lines } = parsePriceList("Rebar Y12 ton 14,500.00");
    expect(lines[0].unitCents).toBe(1450000);
    expect(lines[0].name).toBe("Rebar Y12");
  });

  it("peels the price off the end rather than giving up on the line", () => {
    const { lines, unread } = parsePriceList(COLLAPSED);
    expect(unread).toEqual([]);
    expect(lines).toMatchObject([
      { name: "Paving stone", unit: "m²", unitCents: 48000 },
      { name: "Site labour", unit: "day", unitCents: 180000 },
      { name: "Rebar Y12", unit: "ton", unitCents: 1450000 },
    ]);
  });

  it("takes the amount from the END, so a number in a name is safe", () => {
    const { lines } = parsePriceList("Paving stone 50mm 480.00");
    expect(lines[0]).toMatchObject({ name: "Paving stone 50mm", unitCents: 48000 });
  });

  it("reads a comma followed by a space, which is how people write CSV", () => {
    const { lines } = parsePriceList("Paving stone, 450.00");
    expect(lines[0]).toMatchObject({ name: "Paving stone", unitCents: 45000 });
  });

  it("keeps the European decimal comma inside the number", () => {
    /* "450,00" is digits either side, so it is part of the amount and not a
       column — the same rule that saves the rebar. */
    const { lines } = parsePriceList("Site visit\teach\t450,00");
    expect(lines[0].unitCents).toBe(45000);
  });

  it("drops a heading whose columns also collapsed", () => {
    /* Otherwise a header is reported as unreadable on every import from a
       plain-text list, and noise on every import teaches people to stop
       reading the box that is the whole safety net here. */
    const { lines, unread } = parsePriceList(
      ["Description Unit Price", "Paving stone m² 480.00"].join("\n")
    );
    expect(lines).toHaveLength(1);
    expect(unread).toEqual([]);
  });

  it("still splits a real CSV, where the comma is followed by a word", () => {
    const { lines } = parsePriceList("Paving stone,m²,450.00");
    expect(lines[0]).toMatchObject({ name: "Paving stone", unit: "m²", unitCents: 45000 });
  });
});

describe("what it refuses to guess at", () => {
  it("reports a line with no price rather than dropping it", () => {
    const { lines, unread } = parsePriceList(
      ["Paving stone\tm²\t450.00", "Delivery — price on application"].join("\n")
    );
    expect(lines).toHaveLength(1);
    expect(unread).toEqual([
      { source: "Delivery — price on application", reason: "no price on this line" },
    ]);
  });

  it("reports a price with nothing named against it", () => {
    const { unread } = parsePriceList("\t\t450.00");
    expect(unread[0].reason).toBe("a price with nothing named against it");
  });

  it("reports a zero rather than importing a free product", () => {
    const { unread } = parsePriceList("Site visit\teach\t0.00");
    expect(unread[0].reason).toBe("the price reads as zero");
  });

  it("accounts for EVERY non-empty line, in one bucket or the other", () => {
    /* The property that makes this trustworthy: nothing vanishes. */
    const input = [
      "Paving stone\tm²\t450.00",
      "Delivery — POA",
      "",
      "Site labour\tday\t1,800.00",
      "   ",
      "Call for pricing",
    ].join("\n");
    const { lines, unread } = parsePriceList(input);
    const meaningful = input.split("\n").filter((l) => l.trim()).length;
    expect(lines.length + unread.length).toBe(meaningful);
  });

  it("drops a heading row without calling it a failure", () => {
    /* A supplier's own header. Parsed as a product it would put a line called
       "Description" into somebody's quotation; reported as unread it would be
       noise on every single import. */
    const { lines, unread } = parsePriceList(
      ["Description\tUnit\tPrice", "Paving stone\tm²\t450.00"].join("\n")
    );
    expect(lines).toHaveLength(1);
    expect(unread).toEqual([]);
  });
});

describe("the unit", () => {
  it("is taken when it looks like one", () => {
    expect(parsePriceList("Site labour\tday\t1800").lines[0].unit).toBe("day");
    expect(parsePriceList("Stone\tm²\t450").lines[0].unit).toBe("m²");
    expect(parsePriceList("Hire\tper week\t900").lines[0].unit).toBe("per week");
  });

  it("defaults to each rather than inventing one", () => {
    expect(parsePriceList("Site survey\t2500").lines[0].unit).toBe("each");
  });

  it("stays part of the NAME when it is not a unit", () => {
    /* A middle column that is not a unit is still information — a code, a
       grade — and throwing it away loses what distinguishes two rows. */
    const { lines } = parsePriceList("Paving stone\tCharcoal\t450.00");
    expect(lines[0].name).toBe("Paving stone Charcoal");
    expect(lines[0].unit).toBe("each");
  });
});

describe("what applying it would do", () => {
  const existing: ExistingItem[] = [
    { id: "pi-stone", name: "Paving stone", unitCents: 45000 },
    { id: "pi-labour", name: "Site labour", unitCents: 180000 },
  ];

  it("separates new rows, new prices and rows that have not moved", () => {
    const { lines } = parsePriceList(
      [
        "Paving stone\tm²\t480.00", // a rise
        "Site labour\tday\t1,800.00", // unchanged
        "Bedding sand\tm³\t320.00", // new
      ].join("\n")
    );
    const changes = planChanges(lines, existing);
    expect(changes.map((c) => c.kind)).toEqual(["changed", "same", "new"]);
    expect(changes[0]).toMatchObject({ id: "pi-stone", fromCents: 45000 });
  });

  it("matches on the name regardless of case and spacing", () => {
    /* There is no shared id between their list and ours, and there never will
       be. The name is all the two have in common. */
    const { lines } = parsePriceList("  PAVING   STONE \tm²\t480.00");
    expect(planChanges(lines, existing)[0]).toMatchObject({ kind: "changed", id: "pi-stone" });
  });

  it("says in one sentence what is about to happen", () => {
    /* Pasting the wrong column, or last year's file, silently re-prices the
       whole business — so this is the sentence somebody confirms against. */
    const { lines, unread } = parsePriceList(
      ["Paving stone\tm²\t480.00", "Bedding sand\tm³\t320.00", "Delivery — POA"].join("\n")
    );
    expect(describeChanges(planChanges(lines, existing), unread.length)).toBe(
      "1 new, 1 with a new price, 1 we could not read"
    );
  });

  it("says so plainly when there is nothing to do", () => {
    expect(describeChanges([], 0)).toBe("nothing to apply");
  });
});
