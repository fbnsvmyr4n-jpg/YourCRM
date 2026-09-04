/**
 * Reading a CSV that somebody else's software produced.
 *
 * This is the first thing a trialling agency does, with a file exported from
 * whatever they are leaving. It will not be clean: quoted fields containing
 * commas, addresses with newlines inside them, a byte-order mark from Excel,
 * CRLF line endings from Windows, and doubled quotes for a literal quote.
 *
 * `line.split(",")` handles none of that, and the way it fails is the worst
 * kind: it does not throw. It silently puts half an address in the phone column
 * for exactly the rows that had a comma in them, and the customer discovers it
 * weeks later in a mail merge.
 *
 * So this is a real parser — a small state machine over characters, which is
 * the only thing that gets quoting right.
 */

export type CsvTable = {
  headers: string[];
  rows: string[][];
};

/**
 * Writing one, for the export.
 *
 * The mirror of the parser above and subject to the same rules — a note
 * containing a comma, a quote or a newline has to survive the round trip into
 * Excel and back. Quoted unconditionally rather than only when it looks
 * necessary: "only when necessary" is a second rule to get wrong, and the cost
 * of always quoting is a few bytes.
 *
 * CRLF, because that is what the specification says and what Excel expects.
 *
 * The leading BOM is not decoration. Without it Excel on Windows reads the file
 * as the local code page, and every accented name in an exported contact list
 * arrives mangled — the same customer data, made wrong by the act of exporting
 * it.
 */
export function toCsv(headers: string[], rows: string[][]): string {
  const cell = (value: string) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const line = (values: string[]) => values.map(cell).join(",");
  return `\uFEFF${[line(headers), ...rows.map(line)].join("\r\n")}\r\n`;
}

/** The character separating fields. Detected, because Excel in some locales
 *  exports semicolons and the file otherwise parses as one enormous column. */
export function detectDelimiter(sample: string): "," | ";" | "\t" {
  // Counted outside quotes only: a comma inside "Smith, John" is not evidence
  // of a comma-delimited file, and on a small sample it can outnumber the real
  // delimiter.
  let inQuotes = false;
  const counts = { ",": 0, ";": 0, "\t": 0 };
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "," || ch === ";" || ch === "\t")) {
      counts[ch]++;
    }
  }
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

/**
 * Parse a CSV into headers and rows.
 *
 * Ragged rows are kept rather than rejected. A row with fewer columns than the
 * header is overwhelmingly a trailing empty field, and throwing away somebody's
 * contact because their last column was blank is not a trade worth making.
 */
export function parseCsv(input: string, delimiter?: string): CsvTable {
  // Excel writes a BOM. Left in place it becomes part of the FIRST header, so
  // "email" arrives as "﻿email" and matches nothing — the column silently
  // does not import.
  const text = input.replace(/^\uFEFF/, "");
  const sep = delimiter ?? detectDelimiter(text.slice(0, 4000));

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = "";
    started = false;
  };
  const endRow = () => {
    endField();
    // A blank final line is not a record. Without this every file ending in a
    // newline imports one empty contact.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is a literal quote — the CSV
        // way of escaping. Treating it as the end of the field splits the row
        // in the middle of somebody's company name.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && !started) {
      inQuotes = true;
      started = true;
    } else if (ch === sep) {
      endField();
    } else if (ch === "\r") {
      // CRLF. The \n is handled next; a lone \r (old Mac files) still ends the
      // row, which is why this does not simply skip it.
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (ch === "\n") {
      endRow();
    } else {
      field += ch;
      started = true;
    }
  }

  // Whatever is left when the file ends without a trailing newline.
  if (field !== "" || row.length > 0) endRow();

  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0].map((h) => h.trim());
  return { headers, rows: rows.slice(1) };
}

/** The fields an import can fill. */
export const IMPORT_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "company",
  "location",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/**
 * Header names seen in the wild, per field.
 *
 * Matched loosely — lowercased with everything non-alphanumeric removed — so
 * "First Name", "first_name" and "FIRST-NAME" all land in the same place. The
 * alternative is asking somebody to map six columns by hand before they have
 * seen whether the product is any good.
 */
const ALIASES: Record<ImportField, string[]> = {
  firstName: ["firstname", "first", "givenname", "forename", "fname"],
  lastName: ["lastname", "last", "surname", "familyname", "lname"],
  email: ["email", "emailaddress", "mail", "workemail", "e"],
  phone: ["phone", "phonenumber", "mobile", "cell", "telephone", "tel", "contactnumber"],
  company: ["company", "companyname", "organisation", "organization", "org", "account", "business"],
  location: ["location", "city", "town", "address", "region", "country"],
};

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Aliases that may ONLY match exactly.
 *
 * Abbreviations are short enough to appear inside unrelated words. "fullname"
 * contains "lname", so a loose match had `lastName` claiming the "Full Name"
 * column — and the name split never ran, because a last name had apparently
 * been found. Third time this substring shape has caused a defect here.
 */
const EXACT_ONLY = new Set(["fname", "lname", "e", "org", "tel", "cell"]);

/**
 * Guess which column is which.
 *
 * Returns a map from field to column index. A field with no match is absent,
 * and the caller shows it as unmapped rather than guessing — a wrong guess puts
 * phone numbers in the email column, which is worse than an empty one.
 */
export function guessMapping(headers: string[]): Partial<Record<ImportField, number>> {
  const out: Partial<Record<ImportField, number>> = {};
  const used = new Set<number>();

  /**
   * One pass per field, exact match then a loose one.
   *
   * `used` is what stops two fields claiming the same column, and it is doing
   * the real work here: "Business Email" matches both `email` and `company`,
   * and without it the address is imported as the person's company name while
   * the actual company column is never read.
   */
  for (const field of IMPORT_FIELDS) {
    const aliases = ALIASES[field];
    let found = headers.findIndex((h, i) => !used.has(i) && aliases.includes(normalise(h)));
    if (found === -1) {
      found = headers.findIndex(
        (h, i) =>
          !used.has(i) &&
          aliases.some(
            (a) => a.length > 3 && !EXACT_ONLY.has(a) && normalise(h).includes(a)
          )
      );
    }
    if (found !== -1) {
      out[field] = found;
      used.add(found);
    }
  }

  /**
   * A single "name" column, split only when there is no first-name column.
   *
   * Plenty of exports have one "Full Name". It is split on the FIRST space, so
   * "Ana Maria van der Berg" keeps its surname whole — splitting on the last
   * would leave three quarters of it in the first name.
   */
  if (out.firstName === undefined) {
    const nameCol = headers.findIndex(
      (h, i) => !used.has(i) && ["name", "fullname", "contact", "contactname"].includes(normalise(h))
    );
    if (nameCol !== -1) out.firstName = nameCol;
  }

  return out;
}

/** Split a single name column the way a person would read it. */
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts[0],
    // Everything after the first word, so "Ana Maria van der Berg" keeps its
    // surname intact rather than losing three quarters of it.
    lastName: parts.slice(1).join(" "),
  };
}
