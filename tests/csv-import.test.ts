import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { detectDelimiter, guessMapping, parseCsv, splitName } from "../src/server/csv";
import { readRows } from "../src/server/import-contacts";
import { startTestDb, type TestDb, TENANT_A, TENANT_B } from "./helpers/pg";

/**
 * Importing somebody else's export.
 *
 * The first thing a trialling agency does, and the thing that decides whether
 * they carry on. If it half-works they do not report a bug — they stop.
 *
 * The file will not be clean. These are the shapes real exports arrive in, and
 * `line.split(",")` gets every one of them wrong in the same silent way: it
 * does not throw, it just puts half an address in the phone column for exactly
 * the rows that had a comma in them.
 */

describe("parsing what other software exports", () => {
  it("keeps a comma inside a quoted field", () => {
    const t = parseCsv('name,company\n"Smith, John",Acme');
    expect(t.rows[0], "a quoted comma split the row").toEqual(["Smith, John", "Acme"]);
  });

  it("keeps a newline inside a quoted field", () => {
    // Addresses do this constantly. Splitting on \n turns one contact into two
    // broken ones.
    const t = parseCsv('name,address\nAna,"12 High St\nLondon"');
    expect(t.rows.length).toBe(1);
    expect(t.rows[0][1]).toBe("12 High St\nLondon");
  });

  it("reads a doubled quote as one literal quote", () => {
    const t = parseCsv('name\n"He said ""yes"""');
    expect(t.rows[0][0]).toBe('He said "yes"');
  });

  it("strips the byte-order mark Excel writes", () => {
    /**
     * Left in place it becomes part of the FIRST header, so "email" arrives as
     * "\uFEFFemail", matches no alias, and that column silently does not
     * import — with no error anywhere.
     */
    const t = parseCsv("\uFEFFemail,phone\na@b.c,123");
    expect(t.headers[0], "the BOM stayed in the first header").toBe("email");
    expect(guessMapping(t.headers).email).toBe(0);
  });

  it("strips a byte-order mark sitting in front of a quoted header", () => {
    /**
     * The case that makes the explicit strip necessary rather than decorative.
     *
     * A plain BOM is absorbed by `trim()` on the header — U+FEFF counts as
     * whitespace in JavaScript, so removing the strip changes nothing there.
     * But a BOM immediately before a QUOTED field marks the field as started,
     * so the quote that follows is read as a literal character instead of
     * opening a quoted field. Every comma inside that field then splits the
     * row, and the whole file is shifted from the very first column.
     */
    const t = parseCsv('\uFEFF"Email, primary",phone\n"a@b.c",123');
    expect(t.headers[0], "a quoted first header was broken by the BOM").toBe("Email, primary");
    expect(t.headers.length).toBe(2);
  });

  it("handles Windows line endings", () => {
    const t = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
    expect(t.rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("does not invent a row from a trailing newline", () => {
    // Almost every file ends with one. Without this, every import creates an
    // empty contact.
    const t = parseCsv("name\nAna\n");
    expect(t.rows.length).toBe(1);
  });

  it("reads the last row of a file with no trailing newline", () => {
    const t = parseCsv("name\nAna\nBen");
    expect(t.rows.length).toBe(2);
    expect(t.rows[1][0]).toBe("Ben");
  });

  it("keeps empty fields rather than collapsing them", () => {
    // A dropped empty shifts every later column left, which is how a phone
    // number ends up in the location field.
    const t = parseCsv("a,b,c\n1,,3");
    expect(t.rows[0]).toEqual(["1", "", "3"]);
  });

  it("keeps a row with fewer columns than the header", () => {
    // Overwhelmingly a trailing empty field. Throwing the contact away is not
    // a trade worth making.
    const t = parseCsv("first,last,email\nAna,Silva");
    expect(t.rows.length).toBe(1);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
    expect(parseCsv("\n")).toEqual({ headers: [], rows: [] });
  });
});

describe("the delimiter is detected, not assumed", () => {
  it("finds semicolons, which Excel writes in some locales", () => {
    // Assumed commas, the whole file parses as one enormous column and the
    // import appears to find no data at all.
    const t = parseCsv("first;last;email\nAna;Silva;a@b.c");
    expect(t.headers).toEqual(["first", "last", "email"]);
  });

  it("finds tabs", () => {
    const t = parseCsv("first\tlast\nAna\tSilva");
    expect(t.rows[0]).toEqual(["Ana", "Silva"]);
  });

  it("ignores commas inside quotes when deciding", () => {
    /**
     * "Smith, John" is not evidence of a comma-delimited file. On a small
     * sample those commas can outnumber the real delimiter and the whole file
     * parses wrongly.
     */
    expect(detectDelimiter('a;b\n"Smith, John, Jr";x')).toBe(";");
  });

  it("defaults to a comma when there is nothing to go on", () => {
    expect(detectDelimiter("name")).toBe(",");
  });
});

describe("guessing which column is which", () => {
  it("matches the usual header spellings", () => {
    const m = guessMapping(["First Name", "Last Name", "Email Address", "Mobile"]);
    expect(m.firstName).toBe(0);
    expect(m.lastName).toBe(1);
    expect(m.email).toBe(2);
    expect(m.phone).toBe(3);
  });

  it("ignores case, spaces and punctuation", () => {
    const m = guessMapping(["FIRST_NAME", "last-name", "e-mail"]);
    expect(m.firstName).toBe(0);
    expect(m.lastName).toBe(1);
    expect(m.email).toBe(2);
  });

  it("prefers an exact header over one that merely contains the word", () => {
    /**
     * "Contact Number" contains "contact"; "Contact" is the real name column.
     * Without exact-first, `phone` — which lists "contactnumber" — is fine,
     * but `location` (alias "address") would claim "Email Address" ahead of a
     * plain "Address" column sitting right beside it.
     */
    const m = guessMapping(["Email Address", "Address"]);
    expect(m.email, "the address column was read as the email").toBe(0);
    expect(m.location, "an 'Email Address' column was read as the location").toBe(1);
  });

  it("never maps two fields to the same column", () => {
    /**
     * "Business Email" matches BOTH `email` (contains "email") and `company`
     * (contains "business"). Without claiming a column once it is taken, the
     * same address is imported as the person's email and as their company
     * name — and the real company column, if there is one, is never read.
     */
    const m = guessMapping(["Business Email", "Phone"]);
    const used = Object.values(m);
    expect(new Set(used).size, "two fields claimed the same column").toBe(used.length);
    expect(m.email).toBe(0);
    expect(m.company, "an email column was also read as the company").toBeUndefined();
  });

  it("leaves a field unmapped rather than guessing", () => {
    // A wrong guess puts phone numbers in the email column, which is worse
    // than an empty one.
    const m = guessMapping(["first", "last"]);
    expect(m.email).toBeUndefined();
    expect(m.phone).toBeUndefined();
  });

  it("falls back to a single name column", () => {
    const m = guessMapping(["Full Name", "Email"]);
    expect(m.firstName).toBe(0);
    expect(m.lastName).toBeUndefined();
  });
});

describe("splitting one name column", () => {
  it("keeps a multi-word surname together", () => {
    // Splitting on the FIRST space keeps "van der Berg" whole; splitting on
    // the last would leave three quarters of it in the first name.
    expect(splitName("Ana Maria van der Berg")).toEqual({
      firstName: "Ana",
      lastName: "Maria van der Berg",
    });
  });

  it("handles one word, and nothing", () => {
    expect(splitName("Cher")).toEqual({ firstName: "Cher", lastName: "" });
    expect(splitName("   ")).toEqual({ firstName: "", lastName: "" });
  });
});

describe("rows are refused with a reason, never dropped", () => {
  const map = { firstName: 0, lastName: 1, email: 2, phone: 3 };

  it("reports the line number a person can find in their spreadsheet", () => {
    /**
     * "412 imported" out of a 500-row file, with no account of the other 88,
     * is the worst possible outcome: it looks like success.
     */
    const { rows, issues } = readRows("first,last,email,phone\nAna,Silva,a@b.c,1\n,,, \nBen,Cole,nope,2", map);
    expect(rows.length).toBe(1);
    expect(issues.length).toBe(1);
    expect(issues[0].line, "the reported line does not match the file").toBe(4);
    expect(issues[0].reason).toContain("nope");
  });

  it("refuses a row with no name", () => {
    const { rows, issues } = readRows("first,last,email,phone\n,,a@b.c,123", map);
    expect(rows.length).toBe(0);
    expect(issues[0].reason).toMatch(/no name/);
  });

  it("refuses a nearly-right email rather than importing it blank", () => {
    // Importing it as null hides that there was an address at all, and the
    // customer never learns which rows to fix.
    const { rows, issues } = readRows("first,last,email,phone\nAna,Silva,ana@,1", map);
    expect(rows.length).toBe(0);
    expect(issues.length).toBe(1);
  });

  it("says nothing about blank lines", () => {
    // Not a problem anybody needs to hear about.
    const { rows, issues } = readRows("first,last,email,phone\nAna,Silva,a@b.c,1\n\n", map);
    expect(rows.length).toBe(1);
    expect(issues).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Against a real database                                            */
/* ------------------------------------------------------------------ */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let imports: typeof import("../src/server/import-contacts");
let contacts: typeof import("../src/server/repos/contacts");
let closePool: typeof import("../src/server/db").closePool;

const ctx = (subAccountId: string) => ({
  agencyId: "ag_test",
  subAccountId,
  userId: "u_test_a",
  role: "owner" as const,
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  imports = await import("../src/server/import-contacts");
  contacts = await import("../src/server/repos/contacts");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM contacts; DELETE FROM companies;`));

const FILE = [
  "First Name,Last Name,Email,Mobile,Company",
  "Ana,Silva,ana@silva.co,+27 82 551 4470,Silva Plumbing",
  '"Berg, Ben",Cole,ben@cole.co,0115550000,"Cole & Sons, Ltd"',
  "Cher,,cher@x.co,,",
].join("\n");

describe("importing into a workspace", () => {
  it("imports every good row", async () => {
    const result = await withTenant(ctx(TENANT_A), (q) => imports.importContacts(q, FILE));
    expect(result.imported).toBe(3);
    expect(result.issues).toEqual([]);

    const people = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(people.map((c) => c.email).sort()).toEqual(["ana@silva.co", "ben@cole.co", "cher@x.co"]);
  });

  it("keeps quoted commas out of the wrong columns", async () => {
    await withTenant(ctx(TENANT_A), (q) => imports.importContacts(q, FILE));
    const people = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    const ben = people.find((c) => c.email === "ben@cole.co");
    expect(ben?.firstName, "a quoted comma broke the columns").toBe("Berg, Ben");
    expect(ben?.info).toBe("Cole & Sons, Ltd");
  });

  it("does not double the database when the same file is imported twice", async () => {
    /**
     * People import twice because they are not sure the first one worked.
     * Faithfully creating everybody again is the single most damaging thing an
     * import can do, and it is completely silent.
     */
    await withTenant(ctx(TENANT_A), (q) => imports.importContacts(q, FILE));
    const second = await withTenant(ctx(TENANT_A), (q) => imports.importContacts(q, FILE));

    expect(second.imported, "the second import created duplicates").toBe(0);
    expect(second.skipped).toBe(3);

    const people = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(people.length).toBe(3);
  });

  it("matches a phone number written differently", async () => {
    // "+27 82 551 4470" and "0825514470" are one person. Matching the string
    // exactly duplicates every contact whose number was reformatted.
    await withTenant(ctx(TENANT_A), (q) => imports.importContacts(q, FILE));
    const again = await withTenant(ctx(TENANT_A), (q) =>
      imports.importContacts(q, "First Name,Last Name,Mobile\nAna,Silva,0825514470")
    );
    expect(again.imported, "the same person imported twice under two number formats").toBe(0);
  });

  it("imports a person listed twice in one file only once", async () => {
    // Exports from a system with duplicates are common; importing them
    // faithfully means importing the mess.
    const dupes = "First Name,Last Name,Email\nAna,Silva,ana@silva.co\nAna,Silva,ANA@SILVA.CO";
    const result = await withTenant(ctx(TENANT_A), (q) => imports.importContacts(q, dupes));
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("links each contact to a real company, not just a text field", async () => {
    /**
     * An import is where duplicate companies are born. Five hundred rows whose
     * spreadsheet says "Acme Ltd" and "acme ltd" arrive as ONE company, or the
     * entity has bought nothing.
     */
    const two = [
      "First Name,Last Name,Email,Company",
      "Ana,Silva,ana@x.co,Acme Ltd",
      "Ben,Cole,ben@x.co,acme ltd",
    ].join("\n");
    await withTenant(ctx(TENANT_A), (q) => imports.importContacts(q, two));

    const companies = await import("../src/server/repos/companies");
    const list = await withTenant(ctx(TENANT_A), (q) => companies.listCompanies(q));
    expect(list.length, "two spellings created two companies").toBe(1);

    const people = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(people.every((p) => p.companyId === list[0].id), "a contact was not linked").toBe(true);
    expect(people.every((p) => p.companyName === "Acme Ltd")).toBe(true);
  });

  it("imports into one workspace only", async () => {
    await withTenant(ctx(TENANT_A), (q) => imports.importContacts(q, FILE));
    const theirs = await withTenant(ctx(TENANT_B), (q) => contacts.listContacts(q));
    expect(theirs.length, "an import reached another workspace").toBe(0);
  });

  it("does not treat another workspace's contacts as duplicates", async () => {
    /**
     * The duplicate check reads existing contacts. Scoped wrongly it would
     * silently skip somebody because a DIFFERENT customer already has them —
     * a row that vanishes with no error, and no way to work out why.
     */
    await withTenant(ctx(TENANT_B), (q) => imports.importContacts(q, FILE));
    const mine = await withTenant(ctx(TENANT_A), (q) => imports.importContacts(q, FILE));
    expect(mine.imported, "another workspace's contacts blocked this import").toBe(3);
  });

  it("reports a bad row without abandoning the good ones", async () => {
    const messy = "First Name,Last Name,Email\nAna,Silva,ana@silva.co\n,,\nBen,Cole,not-an-email";
    const result = await withTenant(ctx(TENANT_A), (q) => imports.importContacts(q, messy));
    expect(result.imported).toBe(1);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].line).toBe(4);
  });
});

describe("previewing before writing", () => {
  it("shows what would happen and changes nothing", async () => {
    // A mapping that put phone numbers in the email column is obvious on ten
    // sample rows and invisible in a summary.
    const preview = await withTenant(ctx(TENANT_A), (q) => imports.previewImport(q, FILE));
    expect(preview.total).toBe(3);
    expect(preview.sample[0].firstName).toBe("Ana");
    expect(preview.mapping.email).toBe(2);

    const people = await withTenant(ctx(TENANT_A), (q) => contacts.listContacts(q));
    expect(people.length, "the preview wrote to the database").toBe(0);
  });

  it("counts duplicates within the file as well as against existing contacts", async () => {
    /**
     * Two rows sharing a phone number: the second will be skipped on import.
     * Counting only against what is already on file made the button promise
     * four and deliver three — the preview failing at the one job it has, with
     * no way for the person to tell which row went missing.
     */
    const shared = [
      "First Name,Last Name,Mobile",
      "Ana,Silva,+27 82 551 4470",
      "Eli,Adams,0825514470",
    ].join("\n");

    const preview = await withTenant(ctx(TENANT_A), (q) => imports.previewImport(q, shared));
    expect(preview.total).toBe(2);
    expect(preview.duplicates, "an in-file duplicate was not counted").toBe(1);

    const result = await withTenant(ctx(TENANT_A), (q) => imports.importContacts(q, shared));
    expect(
      result.imported,
      "the preview promised more than the import delivered"
    ).toBe(preview.total - preview.duplicates);
  });

  it("counts how many would be skipped as duplicates", async () => {
    await withTenant(ctx(TENANT_A), (q) => imports.importContacts(q, FILE));
    const preview = await withTenant(ctx(TENANT_A), (q) => imports.previewImport(q, FILE));
    expect(preview.duplicates).toBe(3);
    expect(preview.total).toBe(3);
  });
});
