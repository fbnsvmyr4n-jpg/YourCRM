import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startTestDb, type TestDb, TENANT_A, TENANT_B, AGENCY, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * Notes, gathered from the two places they are actually kept.
 *
 * They are not stored in one shape. A note typed on a contact, a deal or a
 * company becomes an `activities` row with `kind = 'note'`; a note typed on a
 * meeting is written to that meeting's own `notes` column and never becomes an
 * activity at all. A page reading only the first would silently omit every
 * meeting note — which is the failure this file exists to prevent, since the
 * omission looks exactly like "you haven't written any".
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let listNotes: typeof import("../src/server/notes-view").listNotes;
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  ({ listNotes } = await import("../src/server/notes-view"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const notes = (tenant = TENANT_A) => withTenant(ctxFor(tenant), (q) => listNotes(q));

beforeEach(() =>
  db.seed(`DELETE FROM activities; DELETE FROM meetings; DELETE FROM deals; DELETE FROM contacts;`)
);

const seedContact = (id: string, first: string, last: string, tenant = TENANT_A) =>
  db.seed(
    `INSERT INTO contacts (id, sub_account_id, first_name, last_name)
     VALUES ('${id}','${tenant}','${first}','${last}')`
  );

const seedNote = (id: string, type: string, entity: string, body: string, tenant = TENANT_A) =>
  db.seed(
    `INSERT INTO activities (id, sub_account_id, entity_type, entity_id, kind, title, detail)
     VALUES ('${id}','${tenant}','${type}','${entity}','note','Note','${body}')`
  );

describe("both kinds of note arrive", () => {
  it("reads a note written on a contact", async () => {
    await seedContact("c1", "Jordan", "Mkhize");
    await seedNote("n1", "contact", "c1", "Split over two invoices");

    const all = await notes();
    expect(all).toHaveLength(1);
    expect(all[0].subject).toBe("Jordan Mkhize");
    expect(all[0].kind).toBe("contact");
    expect(all[0].href).toBe("/contacts?open=c1");
  });

  it("reads a note written on a MEETING, which is not an activity at all", async () => {
    /* The one a naive implementation misses: this lives in `meetings.notes`,
       not in the activities table. */
    await seedContact("c1", "Jordan", "Mkhize");
    await db.seed(
      `INSERT INTO meetings (id, sub_account_id, contact_id, topic, scheduled_at, notes)
       VALUES ('m1','${TENANT_A}','c1','Site walkthrough', now(), 'Measure the mezzanine')`
    );

    const all = await notes();
    expect(all, "the meeting note was dropped").toHaveLength(1);
    expect(all[0].kind).toBe("meeting");
    expect(all[0].subject).toBe("Site walkthrough");
    expect(all[0].body).toBe("Measure the mezzanine");
  });

  it("puts them in one list, newest first", async () => {
    await seedContact("c1", "Jordan", "Mkhize");
    await db.seed(
      `INSERT INTO meetings (id, sub_account_id, contact_id, topic, scheduled_at, notes, updated_at)
       VALUES ('m1','${TENANT_A}','c1','Walkthrough', now(), 'Older meeting note', now() - interval '2 days')`
    );
    await seedNote("n1", "contact", "c1", "Newer contact note");

    const all = await notes();
    expect(all.map((n) => n.body)).toEqual(["Newer contact note", "Older meeting note"]);
  });
});

describe("what must not appear", () => {
  it("skips an empty note rather than listing a blank row", async () => {
    await seedContact("c1", "Jordan", "Mkhize");
    await seedNote("n1", "contact", "c1", "   ");
    expect(await notes()).toHaveLength(0);
  });

  it("skips a meeting with no notes on it", async () => {
    await seedContact("c1", "Jordan", "Mkhize");
    await db.seed(
      `INSERT INTO meetings (id, sub_account_id, contact_id, topic, scheduled_at)
       VALUES ('m1','${TENANT_A}','c1','No notes here', now())`
    );
    expect(await notes()).toHaveLength(0);
  });

  it("skips a note whose record has been deleted", async () => {
    /* Every row on this page is a link. One pointing at a contact that no
       longer exists is worse than one that is absent. */
    await seedContact("c1", "Jordan", "Mkhize");
    await seedNote("n1", "contact", "c1", "Still here");
    await seedNote("n2", "contact", "gone", "Orphan");
    await db.seed(`UPDATE contacts SET deleted_at = now() WHERE id = 'c1'`);

    expect(await notes()).toHaveLength(0);
  });

  it("does not count another kind of activity as a note", async () => {
    await seedContact("c1", "Jordan", "Mkhize");
    await db.seed(
      `INSERT INTO activities (id, sub_account_id, entity_type, entity_id, kind, title, detail)
       VALUES ('a1','${TENANT_A}','contact','c1','won','Payment recorded','Paid in full')`
    );
    expect(await notes()).toHaveLength(0);
  });

  it("never shows another tenant's notes", async () => {
    await seedContact("c1", "Jordan", "Mkhize", TENANT_B);
    /* No apostrophe: `seedNote` interpolates straight into SQL, so one here
       closes the literal early — which it did, and the error said so. */
    await seedNote("n1", "contact", "c1", "A note belonging to tenant B", TENANT_B);
    expect(await notes(TENANT_A)).toHaveLength(0);
    expect(await notes(TENANT_B)).toHaveLength(1);
  });
});

describe("the page is built for finding, not browsing", () => {
  const view = readFileSync(
    fileURLToPath(new URL("../src/app/(app)/notes/NotesView.tsx", import.meta.url)),
    "utf8"
  );
  const nav = readFileSync(
    fileURLToPath(new URL("../src/components/shell/nav.ts", import.meta.url)),
    "utf8"
  );

  it("searches the subject as well as the body", () => {
    /* "Find Jordan's notes" is the same request as "find the note about
       invoices", and a reader does not distinguish them. */
    expect(view).toMatch(/n\.body\.toLowerCase\(\)\.includes\(q\) \|\| n\.subject\.toLowerCase\(\)\.includes\(q\)/);
  });

  it("offers only the filters that would find something", () => {
    /* A "Companies" tab on an account with no company notes is a control whose
       only possible outcome is an empty list. */
    expect(view).toMatch(/\.filter\(\(k\) => seen\.has\(k\)\)/);
    expect(view).toMatch(/kinds\.length > 1 &&/);
  });

  it("keeps the line breaks the writer typed", () => {
    expect(view).toMatch(/whitespace-pre-line/);
  });

  it("does not let the placeholder run under the search icon", () => {
    /**
     * `.field-input` sets the SHORTHAND `padding: 10px 14px`. It and a Tailwind
     * `pl-9` are both single-class selectors, so source order decides and the
     * utility loses — the class read correctly in the markup and did nothing on
     * screen. An inline style cannot be out-ordered.
     */
    expect(view).toMatch(/style=\{\{ paddingLeft: 36 \}\}/);
    expect(view).not.toMatch(/className="field-input pl-9"/);
  });

  it("sits under Other, above Settings", () => {
    const other = nav.slice(nav.indexOf('heading: "Other"'));
    expect(other.indexOf('href: "/notes"')).toBeGreaterThan(-1);
    expect(other.indexOf('href: "/notes"')).toBeLessThan(other.indexOf('href: "/settings"'));
  });
});
