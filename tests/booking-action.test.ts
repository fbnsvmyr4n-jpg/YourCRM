import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, TENANT_A } from "./helpers/pg";

/**
 * The public booking action, as the internet reaches it.
 *
 * `booking-book.test.ts` covers what a booking may do. This covers the one
 * thing in front of it that a session would normally provide: the rate limit.
 * A booking page is a write endpoint with no password, so the abuse to stop is
 * volume — somebody filling a week of the diary from one connection.
 */

let forwardedFor = "203.0.113.7";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": forwardedFor }),
}));

let db: TestDb;
let action: typeof import("../src/app/(public)/book/[slug]/actions").bookAction;
let closePool: typeof import("../src/server/db").closePool;

const form = (startsAt: string, email = "someone@client.test") => {
  const f = new FormData();
  f.set("slug", "acme-cranes");
  f.set("name", "Some One");
  f.set("email", email);
  f.set("startsAt", startsAt);
  return f;
};

/** A time that is never offered, so every attempt fails without writing. */
const NEVER = "2020-01-01T03:00:00.000Z";

beforeAll(async () => {
  db = await startTestDb();
  ({ closePool } = await import("../src/server/db"));
  ({ bookAction: action } = await import("../src/app/(public)/book/[slug]/actions"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  forwardedFor = "203.0.113.7";
  await db.seed(`
    DELETE FROM login_attempts; DELETE FROM meetings; DELETE FROM contacts;
    DELETE FROM booking_links; DELETE FROM working_hours;
    INSERT INTO working_hours (sub_account_id, weekday, opens_minute, closes_minute)
      SELECT '${TENANT_A}', d, 540, 1020 FROM generate_series(0, 6) AS d;
    INSERT INTO booking_links (id, sub_account_id, slug, title, enabled)
      VALUES ('bl_a', '${TENANT_A}', 'acme-cranes', 'Site visit', TRUE);
  `);
});

describe("one connection cannot fill a diary", () => {
  it("REFUSES AFTER SIX ATTEMPTS FROM ONE ADDRESS, SUCCESSFUL OR NOT", async () => {
    const answers = [];
    for (let i = 0; i < 8; i++) answers.push(await action(undefined, form(NEVER)));

    const refused = answers.filter((a) => a && !a.ok && /too many/i.test(a.error));
    expect(refused.length, "the limit never engaged").toBeGreaterThan(0);
    expect(answers.slice(0, 5).every((a) => a && !a.ok && !/too many/i.test(a.error))).toBe(true);
    expect(answers[7] && !answers[7].ok && /too many/i.test(answers[7].error)).toBe(true);
  });

  it("refuses BEFORE doing any work, so a locked-out caller writes nothing", async () => {
    for (let i = 0; i < 7; i++) await action(undefined, form(NEVER));
    const n = await db.seed(`SELECT 1`);
    void n;
    const blocked = await action(undefined, form("2026-09-07T10:00:00.000Z"));
    expect(blocked && !blocked.ok && /too many/i.test(blocked.error)).toBe(true);
  });

  it("counts per address, so one noisy connection does not lock out everyone", async () => {
    for (let i = 0; i < 8; i++) await action(undefined, form(NEVER));
    forwardedFor = "198.51.100.23";
    const other = await action(undefined, form(NEVER));
    expect(other && !other.ok && /too many/i.test(other.error), "a different address was locked out").toBe(false);
  });

  it("hands the refused time back, so the page can deselect exactly that slot", async () => {
    const out = await action(undefined, form(NEVER));
    expect(out && !out.ok ? out.startsAt : undefined).toBe(NEVER);
  });
});
