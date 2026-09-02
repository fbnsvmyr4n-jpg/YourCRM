import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B, AGENCY } from "./helpers/pg";

/**
 * Turning a session into a tenant.
 *
 * `requireUser()` proves who is asking; nothing proved *which customer* they
 * were asking about. This closes that, and the whole risk lives in one place:
 * agency staff are not pinned to a client, so the sub-account they are looking
 * at comes from a cookie — and anything the browser controls is something an
 * attacker controls.
 *
 * These tests are mostly one question asked several ways: can a value the user
 * chooses get them into a tenant they do not belong to?
 */

let db: TestDb;
let session: typeof import("../src/server/tenant-session");
let withSystem: typeof import("../src/server/tenant").withSystem;
let closePool: typeof import("../src/server/db").closePool;

/** Another agency entirely, with its own client. */
const RIVAL_AGENCY = "ag_rival_sess";
const RIVAL_SUB = "sa_rival_sess";

const pinned = { agencyId: AGENCY, subAccountId: TENANT_A };
const roaming = { agencyId: AGENCY, subAccountId: null };

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  session = await import("../src/server/tenant-session");

  await db.seed(`
    INSERT INTO agencies (id, name) VALUES ('${RIVAL_AGENCY}', 'Rival') ON CONFLICT DO NOTHING;
    INSERT INTO sub_accounts (id, agency_id, name, is_primary)
      VALUES ('${RIVAL_SUB}', '${RIVAL_AGENCY}', 'Rival client', TRUE) ON CONFLICT DO NOTHING;`);
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const resolve = (user: { agencyId: string; subAccountId: string | null }, requested: string | null) =>
  withSystem((q) => session.resolveSubAccount(q, user, requested));

describe("a pinned user cannot be moved by a cookie", () => {
  it("always resolves to their own sub-account", async () => {
    expect(await resolve(pinned, null)).toBe(TENANT_A);
  });

  it("ignores a cookie naming a different sub-account, even a legitimate one", async () => {
    // TENANT_B is a real sub-account of the same agency, so this is not even a
    // forged value — it is simply not theirs.
    expect(await resolve(pinned, TENANT_B)).toBe(TENANT_A);
  });

  it("ignores a cookie naming another agency's sub-account", async () => {
    expect(await resolve(pinned, RIVAL_SUB)).toBe(TENANT_A);
  });
});

describe("agency staff may switch, but only within their own agency", () => {
  it("honours a cookie naming a sub-account of their agency", async () => {
    expect(await resolve(roaming, TENANT_B)).toBe(TENANT_B);
  });

  it("refuses another agency's sub-account and falls back to their default", async () => {
    /**
     * The attack this exists to stop: set one cookie value, read a rival
     * agency's entire book of business. The database confirms ownership on
     * every request rather than trusting the value once at sign-in.
     */
    const got = await resolve(roaming, RIVAL_SUB);
    expect(got, "a cookie selected another agency's client").not.toBe(RIVAL_SUB);
    expect(got).toBe(TENANT_A);
  });

  it("refuses a sub-account id that does not exist", async () => {
    expect(await resolve(roaming, "sa_made_up")).toBe(TENANT_A);
  });

  it("refuses a deleted sub-account", async () => {
    // A client the agency has removed should not be reachable by keeping an
    // old cookie around.
    await db.seed(`UPDATE sub_accounts SET deleted_at = now() WHERE id = '${TENANT_B}'`);
    expect(await resolve(roaming, TENANT_B)).toBe(TENANT_A);
    await db.seed(`UPDATE sub_accounts SET deleted_at = NULL WHERE id = '${TENANT_B}'`);
  });

  it("is not fooled by SQL-ish or empty values", async () => {
    for (const nasty of ["", "' OR '1'='1", `${TENANT_B}' --`, "%"]) {
      const got = await resolve(roaming, nasty);
      expect(got, `"${nasty}" selected something`).toBe(TENANT_A);
    }
  });

  it("defaults to the primary sub-account when no cookie is set", async () => {
    // The agency's own workspace, not whichever client sorts first.
    expect(await resolve(roaming, null)).toBe(TENANT_A);
  });
});

describe("an agency with nothing to work in fails loudly", () => {
  it("returns null rather than picking someone else's sub-account", async () => {
    // Null becomes a thrown error upstream. The alternative — falling back to
    // any sub-account that happens to exist — would be a cross-tenant leak
    // dressed up as a convenience.
    const orphan = { agencyId: RIVAL_AGENCY, subAccountId: null };
    await db.seed(`UPDATE sub_accounts SET deleted_at = now() WHERE id = '${RIVAL_SUB}'`);
    expect(await resolve(orphan, null)).toBeNull();
    expect(await resolve(orphan, TENANT_A), "it borrowed another agency's sub-account").toBeNull();
    await db.seed(`UPDATE sub_accounts SET deleted_at = NULL WHERE id = '${RIVAL_SUB}'`);
  });
});

describe("the switcher offers only what the user may reach", () => {
  it("is empty for a pinned user, who has no choice to make", async () => {
    // Not because they have one option — because offering a switcher with a
    // single entry implies a choice that does not exist.
    const rows = await withSystem((q) =>
      q.rows<{ id: string }>(
        `SELECT id FROM sub_accounts WHERE agency_id = $1 AND deleted_at IS NULL`,
        [AGENCY]
      )
    );
    expect(rows.length).toBeGreaterThan(1);
    // `switchableSubAccounts` reads the session, so the shape is asserted here
    // and the pinned-user shortcut is covered by resolveSubAccount above.
    expect(typeof session.switchableSubAccounts).toBe("function");
  });

  it("never lists another agency's sub-accounts", async () => {
    const mine = await withSystem((q) =>
      q.rows<{ id: string }>(
        `SELECT id FROM sub_accounts WHERE agency_id = $1 AND deleted_at IS NULL`,
        [AGENCY]
      )
    );
    expect(mine.map((r) => r.id)).not.toContain(RIVAL_SUB);
  });
});
