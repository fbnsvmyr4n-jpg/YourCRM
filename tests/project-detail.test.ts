import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The project workspace: who is on the job, what was said, what it costs.
 *
 * Every function here is SQL, so every one is tested against a real Postgres.
 * Nothing in this file would have caught the two mistakes that actually
 * happened while writing it — a join to `calls.deal_id`, which does not exist,
 * and a read of `transcript` as if it were text when it is JSONB — except
 * running the statements. TypeScript checks the shape of the result the code
 * SAYS it gets, which is exactly the thing that was wrong.
 *
 * The fixture is Bradley's own example, sized so every total was worked out by
 * hand before it was asserted.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let projects: typeof import("../src/server/repos/projects");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

const JOB = "d_stellenbosch";

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  projects = await import("../src/server/repos/projects");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM document_lines; DELETE FROM documents; DELETE FROM project_people;
    DELETE FROM messages; DELETE FROM meetings; DELETE FROM activities;
    DELETE FROM calls;
    DELETE FROM deals; DELETE FROM contacts; DELETE FROM companies;
    DELETE FROM users WHERE id LIKE 'u_p%';

    INSERT INTO companies (id, sub_account_id, name) VALUES
      ('co_heineken', '${TENANT_A}', 'Heineken'),
      ('co_other',    '${TENANT_B}', 'Another tenant''s client');

    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role, job_title) VALUES
      ('u_pm', '${AGENCY}', NULL, 'pm@test.local', 'x', 'Nadia Petrov', 'member', 'Project Manager');

    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, phone, company_id) VALUES
      ('ct_procure', '${TENANT_A}', 'Amara', 'Dube',  'amara@heineken.test', '021 555 0100', 'co_heineken'),
      ('ct_site',    '${TENANT_A}', 'Ben',   'Cole',  'ben@heineken.test',   NULL,           'co_heineken');

    INSERT INTO deals (id, sub_account_id, company_id, contact_id, owner_user_id,
                       title, value_cents, stage, site, starts_on, due_on)
    VALUES ('${JOB}', '${TENANT_A}', 'co_heineken', 'ct_procure', 'u_pm',
            'Rebuild warehouse', 1800000_00, 'delivery',
            'Stellenbosch', DATE '2026-09-01', DATE '2026-12-15');`)
);

describe("the project header", () => {
  it("carries the client, the site and the dates", async () => {
    const h = await inA((q) => projects.projectHeader(q, JOB));
    expect(h?.title).toBe("Rebuild warehouse");
    expect(h?.companyName).toBe("Heineken");
    expect(h?.site).toBe("Stellenbosch");
    expect(h?.ownerName).toBe("Nadia Petrov");
    expect(h?.valueCents).toBe(1800000_00);
  });

  it("returns dates as the calendar day, not shifted by a time zone", async () => {
    // A DATE is a day, not an instant. Read as a timestamp and formatted in a
    // zone behind UTC, a 1 September start renders as 31 August — the class of
    // bug the settings time zone exists to prevent, one column over.
    const h = await inA((q) => projects.projectHeader(q, JOB));
    expect(h?.startsOn).toBe("2026-09-01");
    expect(h?.dueOn).toBe("2026-12-15");
  });

  it("is invisible from another tenant", async () => {
    expect(await inB((q) => projects.projectHeader(q, JOB))).toBeNull();
  });
});

describe("who is on the job", () => {
  beforeEach(() =>
    db.seed(`
      INSERT INTO project_people (id, sub_account_id, deal_id, user_id, contact_id, role_on_job) VALUES
        ('pp1', '${TENANT_A}', '${JOB}', 'u_pm', NULL, 'Project Manager'),
        ('pp2', '${TENANT_A}', '${JOB}', NULL, 'ct_procure', 'Procurement'),
        ('pp3', '${TENANT_A}', '${JOB}', NULL, 'ct_site', 'Site contact')`)
  );

  it("returns both sides of the team from one call", async () => {
    const people = await inA((q) => projects.projectPeople(q, JOB));
    expect(people.map((p) => p.name)).toEqual(["Amara Dube", "Ben Cole", "Nadia Petrov"]);
  });

  it("says which side each person is on", async () => {
    const people = await inA((q) => projects.projectPeople(q, JOB));
    expect(people.find((p) => p.name === "Nadia Petrov")?.side).toBe("us");
    expect(people.find((p) => p.name === "Amara Dube")?.side).toBe("client");
  });

  it("carries the contact details you would need to ring them", async () => {
    const amara = (await inA((q) => projects.projectPeople(q, JOB))).find(
      (p) => p.name === "Amara Dube"
    );
    expect(amara?.email).toBe("amara@heineken.test");
    expect(amara?.phone).toBe("021 555 0100");
    expect(amara?.roleOnJob).toBe("Procurement");
  });

  it("drops somebody who has left, without anyone tidying up", async () => {
    await db.seed(`UPDATE contacts SET deleted_at = now() WHERE id = 'ct_site'`);
    const people = await inA((q) => projects.projectPeople(q, JOB));
    expect(people.map((p) => p.name)).not.toContain("Ben Cole");
    expect(people).toHaveLength(2);
  });

  it("refuses somebody who is neither a colleague nor a contact", async () => {
    // The CHECK is what makes "exactly one side" true rather than merely
    // intended. Without it a row with both set is a person who is somehow
    // staff and client at once, and every query that branches on which column
    // is populated quietly picks the first one it looks at.
    await expect(
      db.seed(`INSERT INTO project_people (id, sub_account_id, deal_id, user_id, contact_id)
               VALUES ('pp_none', '${TENANT_A}', '${JOB}', NULL, NULL)`)
    ).rejects.toThrow();
  });

  it("refuses somebody who is recorded as both sides at once", async () => {
    await expect(
      db.seed(`INSERT INTO project_people (id, sub_account_id, deal_id, user_id, contact_id)
               VALUES ('pp_both', '${TENANT_A}', '${JOB}', 'u_pm', 'ct_procure')`)
    ).rejects.toThrow();
  });

  it("refuses to put the same person on a job twice", async () => {
    await expect(
      db.seed(`INSERT INTO project_people (id, sub_account_id, deal_id, contact_id)
               VALUES ('pp_dupe', '${TENANT_A}', '${JOB}', 'ct_procure')`)
    ).rejects.toThrow();
  });
});

describe("quotations and purchase orders", () => {
  beforeEach(() =>
    db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party, issued_on) VALUES
        ('doc_q',  '${TENANT_A}', '${JOB}', 'quote',          'Q-1042', 'accepted', 'Heineken',  DATE '2026-09-02'),
        ('doc_po', '${TENANT_A}', '${JOB}', 'purchase_order', 'PO-88',  'sent',     'Steel Ltd', DATE '2026-09-05');

      INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position) VALUES
        ('l1', '${TENANT_A}', 'doc_q',  'Demolition',      1,     250000_00, 0),
        ('l2', '${TENANT_A}', 'doc_q',  'Steel frame',     2.5,   400000_00, 1),
        ('l3', '${TENANT_A}', 'doc_q',  'Site supervision', 12.5,   8000_00, 2),
        ('l4', '${TENANT_A}', 'doc_po', 'I-beams',         40,     15000_00, 0)`)
  );

  it("totals each line in the database, exactly", async () => {
    /*
       By hand: 1 x 250,000 = 250,000. 2.5 x 400,000 = 1,000,000.
       12.5 x 8,000 = 100,000. The fractional quantities are the point — done
       in JavaScript floats, 2.5 x 40000000 is fine but 12.5 x 800000 is the
       shape that eventually lands a cent out, on the one number a customer
       checks against their own accounts.
    */
    const [po, quote] = await inA((q) => projects.projectDocuments(q, JOB)).then((d) =>
      [d.find((x) => x.kind === "purchase_order")!, d.find((x) => x.kind === "quote")!]
    );
    expect(quote.lines.map((l) => l.totalCents)).toEqual([250000_00, 1000000_00, 100000_00]);
    expect(quote.totalCents).toBe(1350000_00);
    expect(po.totalCents).toBe(600000_00);
  });

  it("keeps the lines in the order they were typed", async () => {
    // Without an explicit position the planner returns whatever it likes and a
    // quotation reads differently every time it is opened.
    const quote = (await inA((q) => projects.projectDocuments(q, JOB))).find(
      (d) => d.kind === "quote"
    );
    expect(quote?.lines.map((l) => l.description)).toEqual([
      "Demolition",
      "Steel frame",
      "Site supervision",
    ]);
  });

  it("keeps quotes and purchase orders apart while storing them together", async () => {
    const docs = await inA((q) => projects.projectDocuments(q, JOB));
    expect(docs.map((d) => d.kind).sort()).toEqual(["purchase_order", "quote"]);
    expect(docs.find((d) => d.kind === "purchase_order")?.party).toBe("Steel Ltd");
  });

  it("refuses two documents of one kind sharing a number", async () => {
    await expect(
      db.seed(`INSERT INTO documents (id, sub_account_id, deal_id, kind, number)
               VALUES ('doc_dupe', '${TENANT_A}', '${JOB}', 'quote', 'q-1042')`)
    ).rejects.toThrow();
  });

  it("lets a quote and a purchase order share a number", async () => {
    // They are different documents in different sequences; a customer whose
    // quotes and POs both start at 1 is normal.
    await expect(
      db.seed(`INSERT INTO documents (id, sub_account_id, deal_id, kind, number)
               VALUES ('doc_ok', '${TENANT_A}', '${JOB}', 'purchase_order', 'Q-1042')`)
    ).resolves.not.toThrow();
  });

  it("returns nothing rather than failing for a project with no documents", async () => {
    await db.seed(`DELETE FROM document_lines; DELETE FROM documents;`);
    expect(await inA((q) => projects.projectDocuments(q, JOB))).toEqual([]);
  });
});

describe("email threads on the job", () => {
  beforeEach(() =>
    db.seed(`
      INSERT INTO messages (id, sub_account_id, contact_id, deal_id, thread_id,
                            direction, subject, body, unread, sent_at) VALUES
        ('m1', '${TENANT_A}', 'ct_procure', '${JOB}', 'th_1', 'received',
         'Warehouse rebuild — scope', 'Please send a quote.', FALSE, '2026-09-01T09:00:00Z'),
        ('m2', '${TENANT_A}', NULL,         '${JOB}', 'th_1', 'sent',
         'Re: Warehouse rebuild — scope', 'Quote attached.', FALSE, '2026-09-02T10:00:00Z'),
        ('m3', '${TENANT_A}', 'ct_site',    '${JOB}', 'th_1', 'received',
         'Re: Re: Warehouse rebuild — scope', 'Looks good to me.', TRUE, '2026-09-03T11:00:00Z'),
        ('m4', '${TENANT_A}', 'ct_site',    '${JOB}', 'th_2', 'received',
         'Site access times', 'Gate opens at six.', TRUE, '2026-09-04T08:00:00Z')`)
  );

  it("groups messages into threads, newest thread first", async () => {
    const threads = await inA((q) => projects.projectThreads(q, JOB));
    expect(threads.map((t) => t.id)).toEqual(["th_2", "th_1"]);
    expect(threads.find((t) => t.id === "th_1")?.messages).toBe(3);
  });

  it("names a thread by what it was opened about, not the last reply", async () => {
    // The newest message is "Re: Re: Warehouse rebuild — scope". Naming threads
    // after the latest subject produces a list of prefixes.
    const thread = (await inA((q) => projects.projectThreads(q, JOB))).find((t) => t.id === "th_1");
    expect(thread?.subject).toBe("Warehouse rebuild — scope");
  });

  it("lists who is in the conversation", async () => {
    const thread = (await inA((q) => projects.projectThreads(q, JOB))).find((t) => t.id === "th_1");
    expect(thread?.participants.sort()).toEqual(["Amara Dube", "Ben Cole"]);
  });

  it("counts what is still unread", async () => {
    const threads = await inA((q) => projects.projectThreads(q, JOB));
    expect(threads.find((t) => t.id === "th_1")?.unread).toBe(1);
    expect(threads.find((t) => t.id === "th_2")?.unread).toBe(1);
  });

  it("ignores mail belonging to another project", async () => {
    await db.seed(`UPDATE messages SET deal_id = NULL WHERE id = 'm4'`);
    expect((await inA((q) => projects.projectThreads(q, JOB))).map((t) => t.id)).toEqual(["th_1"]);
  });
});

describe("the timeline", () => {
  beforeEach(() =>
    db.seed(`
      INSERT INTO messages (id, sub_account_id, contact_id, deal_id, thread_id, direction, subject, body, sent_at)
      VALUES ('m1', '${TENANT_A}', 'ct_procure', '${JOB}', 'th_1', 'received', 'Scope', 'Body', '2026-09-01T09:00:00Z');

      INSERT INTO meetings (id, sub_account_id, deal_id, topic, scheduled_at, notes)
      VALUES ('mt1', '${TENANT_A}', '${JOB}', 'Site walkthrough', '2026-09-03T08:00:00Z', 'Walked the slab.');

      INSERT INTO activities (id, sub_account_id, entity_type, entity_id, kind, title, detail, at)
      VALUES ('a1', '${TENANT_A}', 'deal', '${JOB}', 'note', 'Crane booked', 'For the 10th.', '2026-09-04T12:00:00Z');

      INSERT INTO calls (id, sub_account_id, created_deal_id, caller_name, summary, received_at)
      VALUES ('c1', '${TENANT_A}', '${JOB}', 'Amara Dube', 'Asked about the crane.', '2026-09-05T14:00:00Z');

      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, issued_on)
      VALUES ('doc_q', '${TENANT_A}', '${JOB}', 'quote', 'Q-1042', DATE '2026-09-02');
      INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents)
      VALUES ('l1', '${TENANT_A}', 'doc_q', 'Demolition', 2, 250000_00)`)
  );

  it("merges all five kinds into one chronology, newest first", async () => {
    const events = await inA((q) => projects.projectTimeline(q, JOB));
    expect(events.map((e) => e.kind)).toEqual([
      "call",
      "note",
      "meeting",
      "document",
      "email",
    ]);
  });

  it("reads a call from the columns it actually has", async () => {
    /*
       This is the test that would have caught it. The first version joined
       `calls.deal_id`, which does not exist — the column is `created_deal_id` —
       and selected `transcript` as the detail, which is JSONB and would have
       rendered a turn-by-turn array as raw JSON in a timeline row. Both
       typechecked perfectly.
    */
    const call = (await inA((q) => projects.projectTimeline(q, JOB))).find(
      (e) => e.kind === "call"
    );
    expect(call?.title).toBe("Amara Dube");
    expect(call?.detail).toBe("Asked about the crane.");
  });

  it("carries the money on a document event", async () => {
    // By hand: 2 x 250,000 = 500,000.
    const doc = (await inA((q) => projects.projectTimeline(q, JOB))).find(
      (e) => e.kind === "document"
    );
    expect(doc?.title).toBe("Quotation Q-1042");
    expect(doc?.amountCents).toBe(500000_00);
  });

  it("gives every event an id unique across kinds", async () => {
    /*
       Exercised with a real collision, not just asserted on a fixture that
       happens not to have one. The first version of this test passed against a
       bare `r.id`, because no two rows in the fixture shared a primary key —
       it was checking that the fixture was tidy, not that the code was right.

       Ids are per table, so a message and a meeting called "shared" is an
       ordinary state. Keyed on the bare id, React renders one and drops the
       other with a duplicate-key warning nobody reads.
    */
    await db.seed(`
      INSERT INTO messages (id, sub_account_id, deal_id, thread_id, direction, subject, body, sent_at)
      VALUES ('shared', '${TENANT_A}', '${JOB}', 'th_x', 'sent', 'Same id', 'x', '2026-09-06T09:00:00Z');
      INSERT INTO meetings (id, sub_account_id, deal_id, topic, scheduled_at)
      VALUES ('shared', '${TENANT_A}', '${JOB}', 'Also same id', '2026-09-06T10:00:00Z');`);

    const events = await inA((q) => projects.projectTimeline(q, JOB));
    const collided = events.filter((e) => e.id.endsWith("-shared"));
    expect(collided, "the collision fixture did not land").toHaveLength(2);
    const ids = events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows another tenant nothing", async () => {
    expect(await inB((q) => projects.projectTimeline(q, JOB))).toEqual([]);
  });
});
