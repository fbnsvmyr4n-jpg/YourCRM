import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";

/**
 * An enquiry from a stranger, onto the Leads screen.
 *
 * The request arrives from a machine nobody controls, so the tests are about
 * what it may and may not do: land as a real lead exactly like a phone enquiry,
 * never duplicate a person or a lead on a double press, never write anything
 * for a bot, and never exist at all for a business that has not switched the
 * form on.
 */

let db: TestDb;
let en: typeof import("../src/server/enquiry/enquire");
let links: typeof import("../src/server/repos/booking-links");
let withSystem: typeof import("../src/server/tenant").withSystem;
let closePool: typeof import("../src/server/db").closePool;

const request = (over: Partial<Parameters<typeof en.enquire>[0]> = {}) => ({
  slug: "acme-cranes",
  name: "Amara Dube",
  email: "Amara@Heineken.test",
  phone: "+27 21 555 0100",
  message: "We need a 50 tonne crane for three days next month.\nSite is in Stellenbosch.",
  trap: "",
  ...over,
});

const rows = <T>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  en = await import("../src/server/enquiry/enquire");
  links = await import("../src/server/repos/booking-links");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM activities; DELETE FROM deals; DELETE FROM contacts; DELETE FROM booking_links;
    UPDATE sub_accounts SET deleted_at = NULL;
    -- Enquiries on, bookings OFF: the two switches are independent.
    INSERT INTO booking_links (id, sub_account_id, slug, title, enabled, enquiries_enabled)
      VALUES ('bl_a', '${TENANT_A}', 'acme-cranes', 'Site visit', FALSE, TRUE);
  `)
);

describe("what an enquiry becomes", () => {
  it("LANDS AS A NEW LEAD, EXACTLY THE WAY A PHONE ENQUIRY DOES", async () => {
    const out = await en.enquire(request());
    expect(out).toEqual({ ok: true, workspaceName: "Tenant A" });

    const [deal] = await rows<{ title: string; stage: string; source: string; owner_user_id: string; sub_account_id: string; value_cents: string }>(
      `SELECT title, stage, source, owner_user_id, sub_account_id, value_cents::text FROM deals`
    );
    expect(deal.stage).toBe("prospect");
    expect(deal.source).toBe("website");
    expect(deal.owner_user_id).toBe(USER_A);
    expect(deal.sub_account_id).toBe(TENANT_A);
    expect(deal.value_cents, "a value was invented for an enquiry that named none").toBe("0");
    expect(deal.title).toBe("Amara Dube — We need a 50 tonne crane for three days next month.");
  });

  it("files the person as a contact, with their email lowercased and their phone", async () => {
    await en.enquire(request());
    const contacts = await rows<{ first_name: string; last_name: string; email: string; phone: string }>(
      `SELECT first_name, last_name, email, phone FROM contacts`
    );
    expect(contacts).toEqual([
      { first_name: "Amara", last_name: "Dube", email: "amara@heineken.test", phone: "+27 21 555 0100" },
    ]);
  });

  it("KEEPS THE MESSAGE IN THEIR OWN WORDS, line breaks and all", async () => {
    await en.enquire(request());
    const [note] = await rows<{ entity_type: string; kind: string; title: string; detail: string }>(
      `SELECT entity_type, kind, title, detail FROM activities WHERE kind = 'note'`
    );
    expect(note.entity_type).toBe("contact");
    expect(note.title).toBe("Website enquiry");
    expect(note.detail).toBe("We need a 50 tonne crane for three days next month.\nSite is in Stellenbosch.");
  });

  it("reuses a contact already on file by email, and never overwrites the phone they have", async () => {
    await db.seed(`
      INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, phone)
        VALUES ('ct_known', '${TENANT_A}', 'Amara', 'Dube', 'amara@heineken.test', '+27 82 000 0000');
    `);
    await en.enquire(request({ phone: "+27 21 555 0100" }));

    const contacts = await rows<{ id: string; phone: string }>(`SELECT id, phone FROM contacts`);
    expect(contacts, "the same person became two contacts").toEqual([{ id: "ct_known", phone: "+27 82 000 0000" }]);
    const [note] = await rows<{ detail: string }>(`SELECT detail FROM activities WHERE kind = 'note'`);
    expect(note.detail, "the new number was thrown away").toMatch(/Phone given: \+27 21 555 0100$/);
  });

  it("creates a new contact rather than guessing when two already share the address", async () => {
    /*
       Found by a mutation run: removing the email lowercasing broke nothing,
       because contact linking lowercases on its own — everywhere except this
       fallback, which no test reached. Two existing contacts sharing one
       address is exactly the case linking refuses to guess at, and the
       enquiry must still land somewhere a person can see and tidy up.
    */
    await db.seed(`
      INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
        ('ct_twin_a', '${TENANT_A}', 'Amara', 'Dube', 'amara@heineken.test'),
        ('ct_twin_b', '${TENANT_A}', 'A.',    'Dube', 'amara@heineken.test');
    `);
    const out = await en.enquire(request({ email: "AMARA@Heineken.TEST" }));
    expect(out.ok).toBe(true);

    const created = await rows<{ id: string; email: string }>(
      `SELECT id, email FROM contacts WHERE id NOT IN ('ct_twin_a', 'ct_twin_b')`
    );
    expect(created, "the enquiry was merged into one of two ambiguous contacts").toHaveLength(1);
    expect(created[0].email, "the new contact's email was stored as typed").toBe("amara@heineken.test");

    const [deal] = await rows<{ contact_id: string }>(`SELECT contact_id FROM deals`);
    expect(deal.contact_id).toBe(created[0].id);
  });

  it("A SECOND SEND WITHIN HALF AN HOUR ADDS A NOTE, NOT A SECOND LEAD", async () => {
    await en.enquire(request());
    await en.enquire(request({ message: "Sorry, forgot to say — we also need a rigger." }));

    expect(await rows(`SELECT id FROM deals`), "a double send opened two leads").toHaveLength(1);
    const notes = await rows<{ title: string }>(`SELECT title FROM activities WHERE kind = 'note' ORDER BY at`);
    expect(notes.map((n) => n.title)).toEqual(["Website enquiry", "Website enquiry (follow-up)"]);
  });

  it("opens a new lead once the earlier one is older than the window", async () => {
    await en.enquire(request());
    await db.seed(`UPDATE deals SET created_at = now() - interval '${en.SAME_ENQUIRY_MINUTES + 5} minutes'`);
    await en.enquire(request({ message: "A different job this time." }));
    expect(await rows(`SELECT id FROM deals`)).toHaveLength(2);
  });
});

describe("who can use the form", () => {
  it("REFUSES A LINK THAT IS NOT PUBLISHED FOR ENQUIRIES, even if it takes bookings", async () => {
    await db.seed(`UPDATE booking_links SET enabled = TRUE, enquiries_enabled = FALSE`);
    const out = await en.enquire(request());
    expect(out).toEqual({ ok: false, reason: "not_found", detail: "That enquiry form is not available." });
    expect(await rows(`SELECT id FROM contacts`)).toHaveLength(0);
    expect(await rows(`SELECT id FROM deals`)).toHaveLength(0);
  });

  it("keeps the two pages independent in the lookup itself", async () => {
    const asEnquiry = await withSystem((q) => links.resolveSlug(q, "acme-cranes", "enquiry"));
    const asBooking = await withSystem((q) => links.resolveSlug(q, "acme-cranes", "booking"));
    expect(asEnquiry?.slug).toBe("acme-cranes");
    expect(asBooking, "an enquiry-only link opened as a booking page").toBeNull();
  });

  it("gives the same answer for an unknown link as for an unpublished one", async () => {
    const unknown = await en.enquire(request({ slug: "nobody-here" }));
    await db.seed(`UPDATE booking_links SET enquiries_enabled = FALSE`);
    const unpublished = await en.enquire(request());
    expect(unknown).toEqual(unpublished);
  });

  it("does not resolve for a deleted workspace", async () => {
    await db.seed(`UPDATE sub_accounts SET deleted_at = now() WHERE id = '${TENANT_A}'`);
    const out = await en.enquire(request());
    expect(out.ok).toBe(false);
  });

  it("lands only in the workspace that published the form", async () => {
    await en.enquire(request());
    expect(await rows(`SELECT id FROM deals WHERE sub_account_id = '${TENANT_B}'`)).toHaveLength(0);
    expect(AGENCY).toBeTruthy();
  });
});

describe("what a bot gets", () => {
  it("IS TOLD THANKS, AND NOTHING IS WRITTEN", async () => {
    const out = await en.enquire(request({ trap: "http://spam.example" }));
    expect(out, "the trap revealed itself").toEqual({ ok: true, workspaceName: "Tenant A" });
    expect(await rows(`SELECT id FROM contacts`)).toHaveLength(0);
    expect(await rows(`SELECT id FROM deals`)).toHaveLength(0);
    expect(await rows(`SELECT id FROM activities`)).toHaveLength(0);
  });
});

describe("what a malformed request gets", () => {
  it.each([
    ["no name", { name: "   " }, /name/i],
    ["a bad email", { email: "not-an-email" }, /email/i],
    ["an email with no domain", { email: "a@b" }, /email/i],
    ["no message", { message: "  \n  " }, /what you need/i],
    ["a phone that is not one", { phone: "call me maybe" }, /phone/i],
  ])("refuses %s, and writes nothing", async (_what, over, pattern) => {
    const out = await en.enquire(request(over as Partial<Parameters<typeof en.enquire>[0]>));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("invalid");
      expect(out.detail).toMatch(pattern as RegExp);
    }
    expect(await rows(`SELECT id FROM contacts`)).toHaveLength(0);
  });

  it("accepts no phone at all", async () => {
    const out = await en.enquire(request({ phone: "" }));
    expect(out.ok).toBe(true);
    const [c] = await rows<{ phone: string | null }>(`SELECT phone FROM contacts`);
    expect(c.phone).toBeNull();
  });

  it("bounds what a stranger can store", async () => {
    await en.enquire(request({ name: "x".repeat(5000), message: "y".repeat(50_000) }));
    const [note] = await rows<{ detail: string }>(`SELECT detail FROM activities WHERE kind = 'note'`);
    const [deal] = await rows<{ title: string }>(`SELECT title FROM deals`);
    expect(note.detail.length).toBeLessThanOrEqual(2000);
    expect(deal.title.length).toBeLessThanOrEqual(80 + 3 + 60);
  });

  it("collapses a wall of blank lines but keeps paragraphs", async () => {
    await en.enquire(request({ message: "First.\n\n\n\n\nSecond." }));
    const [note] = await rows<{ detail: string }>(`SELECT detail FROM activities WHERE kind = 'note'`);
    expect(note.detail).toBe("First.\n\nSecond.");
  });
});
