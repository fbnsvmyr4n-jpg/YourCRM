import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, TENANT_A } from "./helpers/pg";

/**
 * The public enquiry action, as the internet reaches it.
 *
 * `enquiry.test.ts` covers what an enquiry may do. This covers the one thing in
 * front of it that a session would normally provide: the rate limit. The abuse
 * to stop is volume — somebody filling a business's Leads screen with rubbish
 * from one connection.
 */

let forwardedFor = "203.0.113.9";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": forwardedFor }),
}));

let db: TestDb;
let action: typeof import("../src/app/(public)/enquire/[slug]/actions").enquireAction;
let closePool: typeof import("../src/server/db").closePool;

/** A request that is always refused as invalid, so attempts write nothing. */
const junk = () => {
  const f = new FormData();
  f.set("slug", "acme-cranes");
  f.set("name", "Some One");
  f.set("email", "not-an-email");
  f.set("message", "Hello");
  return f;
};

beforeAll(async () => {
  db = await startTestDb();
  ({ closePool } = await import("../src/server/db"));
  ({ enquireAction: action } = await import("../src/app/(public)/enquire/[slug]/actions"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  forwardedFor = "203.0.113.9";
  await db.seed(`
    DELETE FROM login_attempts; DELETE FROM deals; DELETE FROM contacts; DELETE FROM booking_links;
    INSERT INTO booking_links (id, sub_account_id, slug, title, enquiries_enabled)
      VALUES ('bl_a', '${TENANT_A}', 'acme-cranes', 'Site visit', TRUE);
  `);
});

const tooMany = (s: Awaited<ReturnType<typeof action>>) => Boolean(s && !s.ok && /too many/i.test(s.error));

describe("one connection cannot fill the Leads screen", () => {
  it("REFUSES AFTER FIVE ATTEMPTS FROM ONE ADDRESS", async () => {
    const answers = [];
    for (let i = 0; i < 7; i++) answers.push(await action(undefined, junk()));
    expect(answers.slice(0, 4).some(tooMany), "the limit engaged too early").toBe(false);
    expect(tooMany(answers[6]), "the limit never engaged").toBe(true);
  });

  it("refuses before doing any work, so a locked-out caller writes nothing", async () => {
    for (let i = 0; i < 6; i++) await action(undefined, junk());
    const f = junk();
    f.set("email", "real@person.test");
    const blocked = await action(undefined, f);
    expect(tooMany(blocked)).toBe(true);
    // No contact was created by the request that would otherwise have been valid.
    const { withSystem } = await import("../src/server/tenant");
    const contacts = await withSystem((q) => q.rows(`SELECT id FROM contacts`));
    expect(contacts).toHaveLength(0);
  });

  it("counts per address, so one noisy connection does not lock out everyone", async () => {
    for (let i = 0; i < 7; i++) await action(undefined, junk());
    forwardedFor = "198.51.100.44";
    expect(tooMany(await action(undefined, junk())), "a different address was locked out").toBe(false);
  });
});
