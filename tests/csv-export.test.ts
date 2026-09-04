import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "../src/server/csv";

/**
 * Writing a CSV somebody else's software will read.
 *
 * The parser in this module exists because `line.split(",")` silently corrupts
 * exactly the rows that had a comma in them. The writer has the same failure
 * available to it in the other direction, so it is tested the same way: the
 * fixtures are the awkward values a real CRM holds — an address with a comma, a
 * note with a newline, a company name with a quote in it.
 *
 * Most of these go out and come back through this module's own parser. A round
 * trip is a stronger claim than an assertion about the string, because it is the
 * claim that actually matters: what a spreadsheet gets back is what was in the
 * database.
 */

const round = (headers: string[], rows: string[][]) => parseCsv(toCsv(headers, rows));

describe("writing a CSV", () => {
  it("survives commas, quotes and newlines", () => {
    const headers = ["Name", "Address", "Note"];
    const rows = [
      ["Smith, John", '12 "The Oaks", Kenilworth', "Called Tuesday.\nWants a quote."],
      ["Amara Dube", "", "Nothing odd here"],
    ];
    const back = round(headers, rows);
    expect(back.headers).toEqual(headers);
    expect(back.rows).toEqual(rows);
  });

  it("does not lose a semicolon-heavy row to delimiter detection", () => {
    // The parser sniffs its delimiter. A note full of semicolons could out-vote
    // the real commas and split the file down the wrong axis.
    const rows = [["a; b; c; d; e", "x; y; z", "p; q"]];
    expect(round(["One", "Two", "Three"], rows).rows).toEqual(rows);
  });

  it("keeps empty trailing fields rather than dropping the column", () => {
    const rows = [["Only", "", ""]];
    const back = round(["A", "B", "C"], rows);
    expect(back.rows[0]).toHaveLength(3);
  });

  it("writes headers alone when there is nothing to export", () => {
    // An empty workspace should produce a usable file, not an empty one: a
    // spreadsheet with the right columns and no rows says "nothing here yet",
    // and a zero-byte file says "the export is broken".
    const back = round(["Name", "Email"], []);
    expect(back.headers).toEqual(["Name", "Email"]);
    expect(back.rows).toEqual([]);
  });

  it("starts with a BOM, so Excel reads accents correctly", () => {
    // Without it Excel on Windows falls back to the local code page and every
    // accented name arrives mangled — customer data made wrong by exporting it.
    const csv = toCsv(["Name"], [["Renée Söderberg"]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(parseCsv(csv).rows[0][0]).toBe("Renée Söderberg");
  });

  it("ends every line with CRLF", () => {
    const csv = toCsv(["A"], [["1"], ["2"]]);
    expect(csv).toBe('﻿"A"\r\n"1"\r\n"2"\r\n');
  });
});
