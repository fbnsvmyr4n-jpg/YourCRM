import { findOrCreateCompany } from "./repos/companies";
import { createContact, listContacts } from "./repos/contacts";
import type { TenantQuery } from "./tenant";
import { guessMapping, parseCsv, splitName, type ImportField } from "./csv";

/**
 * Bringing an existing book of business in.
 *
 * The first thing a trialling agency does, and the thing that decides whether
 * they carry on. If it half-works they do not report a bug — they stop.
 *
 * Three rules, each learned from how imports usually go wrong:
 *
 *  1. **Nothing is silently dropped.** Every row is either imported, skipped as
 *     a duplicate, or reported with the reason and its line number. A count of
 *     "412 imported" from a 500-row file, with no account of the other 88, is
 *     the worst possible outcome: it looks like success.
 *  2. **Duplicates are matched, not created.** Importing twice — which people
 *     do, because they are not sure the first one worked — must not double the
 *     database.
 *  3. **It previews before it writes.** A mapping that put phone numbers in the
 *     email column is obvious on ten sample rows and invisible in a summary.
 */

export type ImportRow = {
  /** 1-based line in the file, counting the header, so it matches the editor. */
  line: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  location: string | null;
};

export type ImportIssue = { line: number; reason: string };

export type ImportPreview = {
  headers: string[];
  mapping: Partial<Record<ImportField, number>>;
  /** The first rows, as they would be imported. */
  sample: ImportRow[];
  total: number;
  issues: ImportIssue[];
  /** Rows matching somebody already on file. */
  duplicates: number;
};

export type ImportResult = {
  imported: number;
  skipped: number;
  issues: ImportIssue[];
};

const clean = (v: string | undefined): string => (v ?? "").trim();

/** Digits only, last nine — the same rule the caller matching uses, so
 *  "+27 82 551 4470" and "0825514470" are one person, not two. */
const phoneKey = (phone: string | null): string | null => {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
};

const emailKey = (email: string | null): string | null =>
  email ? email.trim().toLowerCase() : null;

/**
 * Turn a parsed file into rows, collecting reasons rather than throwing.
 *
 * One malformed row must not abort an import of five hundred. The caller is
 * told which lines were refused and why, and can fix those alone.
 */
export function readRows(
  csv: string,
  mapping: Partial<Record<ImportField, number>>,
  opts: { splitFullName?: boolean } = {}
): { rows: ImportRow[]; issues: ImportIssue[] } {
  const { rows: raw } = parseCsv(csv);
  const rows: ImportRow[] = [];
  const issues: ImportIssue[] = [];

  const at = (cells: string[], field: ImportField): string => {
    const i = mapping[field];
    return i === undefined ? "" : clean(cells[i]);
  };

  raw.forEach((cells, index) => {
    // +2: one for the header, one because people count from 1.
    const line = index + 2;

    // A row of empty strings is what a trailing blank line looks like after
    // parsing. Silently skipped rather than reported — it is not a problem
    // anybody needs to hear about.
    if (cells.every((c) => clean(c) === "")) return;

    let firstName = at(cells, "firstName");
    let lastName = at(cells, "lastName");

    if (opts.splitFullName && !lastName) {
      const split = splitName(firstName);
      firstName = split.firstName;
      lastName = split.lastName;
    }

    const email = at(cells, "email") || null;
    const phone = at(cells, "phone") || null;

    if (!firstName && !lastName) {
      // Named by what is missing and where. "Invalid row" sends somebody
      // hunting through a spreadsheet.
      issues.push({ line, reason: "no name in this row" });
      return;
    }

    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      // Refused rather than imported blank: an address that is nearly right is
      // worth fixing, and importing it as null hides that there was one.
      issues.push({ line, reason: `"${email}" is not an email address` });
      return;
    }

    rows.push({
      line,
      firstName,
      lastName,
      email,
      phone,
      company: at(cells, "company") || null,
      location: at(cells, "location") || null,
    });
  });

  return { rows, issues };
}

/** What the file would do, without doing it. */
export async function previewImport(q: TenantQuery, csv: string): Promise<ImportPreview> {
  const { headers } = parseCsv(csv);
  const mapping = guessMapping(headers);
  const splitFullName = mapping.lastName === undefined;
  const { rows, issues } = readRows(csv, mapping, { splitFullName });

  /**
   * Counted the way the import will actually behave, including duplicates
   * WITHIN the file.
   *
   * Counting only against existing contacts made the preview promise four and
   * deliver three, because two rows shared a phone number. A button that says
   * "Import 4 contacts" and imports 3 is the preview failing at the one job it
   * has — and the person has no way to tell which one went.
   */
  const keys = await existingKeys(q);
  let duplicates = 0;
  for (const row of rows) {
    if (isDuplicate(row, keys)) {
      duplicates++;
      continue;
    }
    const e = emailKey(row.email);
    if (e) keys.emails.add(e);
    const p = phoneKey(row.phone);
    if (p) keys.phones.add(p);
  }

  return {
    headers,
    mapping,
    sample: rows.slice(0, 10),
    total: rows.length,
    issues,
    duplicates,
  };
}

type Keys = { emails: Set<string>; phones: Set<string> };

async function existingKeys(q: TenantQuery): Promise<Keys> {
  const people = await listContacts(q);
  return {
    emails: new Set(people.map((c) => emailKey(c.email)).filter((k): k is string => !!k)),
    phones: new Set(people.map((c) => phoneKey(c.phone)).filter((k): k is string => !!k)),
  };
}

function isDuplicate(row: ImportRow, keys: Keys): boolean {
  const e = emailKey(row.email);
  if (e && keys.emails.has(e)) return true;
  const p = phoneKey(row.phone);
  if (p && keys.phones.has(p)) return true;
  return false;
}

/**
 * Import the file.
 *
 * Duplicates are skipped, not merged: overwriting somebody's carefully
 * maintained record with a row from an old export is a loss they cannot undo,
 * and they did not ask for it. Skipping is recoverable — they can look at the
 * count and decide.
 *
 * Runs in the caller's transaction, so a failure part-way leaves nothing
 * behind rather than half a contact list nobody can tell apart from a whole one.
 */
export async function importContacts(
  q: TenantQuery,
  csv: string,
  opts: { ownerUserId?: string | null } = {}
): Promise<ImportResult> {
  const { headers } = parseCsv(csv);
  const mapping = guessMapping(headers);
  const splitFullName = mapping.lastName === undefined;
  const { rows, issues } = readRows(csv, mapping, { splitFullName });

  const keys = await existingKeys(q);
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    if (isDuplicate(row, keys)) {
      skipped++;
      continue;
    }

    /**
     * The company becomes a row, matched case-insensitively by name.
     *
     * An import is where duplicate companies are born: five hundred contacts
     * whose spreadsheet says "Acme Ltd", "Acme Ltd." and "acme ltd" would
     * otherwise arrive as three companies, which is precisely the mess the
     * entity exists to prevent.
     */
    const company = row.company ? await findOrCreateCompany(q, row.company) : null;

    await createContact(q, {
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      phone: row.phone,
      companyId: company?.id ?? null,
      // Kept as well as the link. It costs nothing and it is the only copy if
      // the company row is ever removed.
      info: row.company,
      location: row.location,
      ownerUserId: opts.ownerUserId ?? null,
    });

    // Added as we go, so a file containing the same person twice imports them
    // once. Exports from a system with duplicates are common, and importing
    // them faithfully means importing the mess.
    const e = emailKey(row.email);
    if (e) keys.emails.add(e);
    const p = phoneKey(row.phone);
    if (p) keys.phones.add(p);

    imported++;
  }

  return { imported, skipped, issues };
}
