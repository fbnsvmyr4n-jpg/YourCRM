import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "../src/server/csv";

/**
 * What leaves the building in an exported file.
 *
 * The export is opened in Excel — that is the whole point of it — and this CRM
 * takes input from strangers: anybody can submit the public enquiry form, that
 * becomes a contact, and contacts are exported. So a cell can contain whatever
 * a stranger typed, and Excel evaluates any cell beginning with `=`, `+`, `-`
 * or `@` as a formula. Quoting does not stop it: the quotes are CSV syntax and
 * are gone before the cell is parsed.
 *
 * Found on 2026-09-30 by submitting the enquiry form with `=1+1` as a name and
 * finding it intact in the file. The payloads that matter are not arithmetic —
 * they read other cells and send them to a server.
 */

describe("a cell a spreadsheet would run", () => {
  const cellsOf = (value: string) => {
    const csv = toCsv(["Value"], [[value]]);
    return parseCsv(csv).rows[0][0];
  };

  for (const payload of [
    "=1+1",
    "=HYPERLINK(\"http://evil.test\",\"click\")",
    "+1+1",
    "-1+1",
    "@SUM(A1:A9)",
    "=cmd|'/c calc'!A1",
  ]) {
    it(`defuses ${payload.slice(0, 28)}`, () => {
      const out = cellsOf(payload);
      expect(out.startsWith("'"), `left runnable: ${out}`).toBe(true);
      /* And the original is still there to read — this protects the reader,
         it does not throw away what somebody wrote. */
      expect(out.slice(1)).toBe(payload);
    });
  }

  it("LEAVES A NEGATIVE NUMBER AS A NUMBER, so a spreadsheet can still sum it", () => {
    /* The one case where defusing would do damage: a credit is money, and an
       apostrophe would turn the column into text. A plain number cannot be a
       formula whatever it starts with. */
    expect(cellsOf("-500.00")).toBe("-500.00");
    expect(cellsOf("1234.50")).toBe("1234.50");
    expect(cellsOf("-7")).toBe("-7");
  });

  it("leaves ordinary text alone", () => {
    expect(cellsOf("Amara Dube")).toBe("Amara Dube");
    expect(cellsOf("Paving — phase 1")).toBe("Paving — phase 1");
  });
});

describe("the file Excel actually opens", () => {
  it("keeps a comma, a quote and a newline intact through the round trip", () => {
    const awkward = 'Smith, John said "yes"\nsecond line';
    const back = parseCsv(toCsv(["Note"], [[awkward]])).rows[0][0];
    expect(back).toBe(awkward);
  });

  it("starts with the byte order mark, or accented names arrive mangled", () => {
    expect(toCsv(["Name"], [["Zoë"]]).charCodeAt(0)).toBe(0xfeff);
  });

  it("leaves an ordinary header exactly as written", () => {
    const csv = toCsv(["Value (ZAR)"], [["1.00"]]);
    expect(parseCsv(csv).headers[0]).toBe("Value (ZAR)");
  });

  it("DEFUSES A HEADER TOO — a custom field's label is somebody's typing", () => {
    /* Headers are not all ours: the export adds a column per custom field,
       named by whoever created it. A field called "=1+1" would otherwise be a
       formula in the first row of the file. */
    const csv = toCsv(["=1+1"], [["x"]]);
    expect(parseCsv(csv).headers[0]).toBe("'=1+1");
  });
});
