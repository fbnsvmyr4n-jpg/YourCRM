import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, USER_A } from "./helpers/pg";

/**
 * Adding, promoting and removing colleagues.
 *
 * Two rules carry all the risk here, and both are enforced inside the UPDATE
 * rather than by a check before it:
 *
 *  - **The agency scope.** Ids are globally unique, so another customer's user
 *    id is a valid-looking string. A form field is the only thing carrying it,
 *    and a check performed in the action would be one a second caller does not
 *    have.
 *  - **The last owner.** An agency with no owner is an agency nobody can bill
 *    for and no screen in the product can repair. Checking "is there another
 *    owner?" with a separate SELECT leaves a window where two simultaneous
 *    demotions both read yes.
 *
 * So both are tested against the database, not against the action, because the
 * database is where they live.
 */

let db: TestDb;
let withSystem: typeof import("../src/server/tenant").withSystem;
let users: typeof import("../src/server/repos/users");
let closePool: typeof import("../src/server/db").closePool;

const OWNER = "u_team_owner";
const SECOND_OWNER = "u_team_owner_2";
const ADMIN = "u_team_admin";
const MEMBER = "u_team_member";
/** Somebody else's employee entirely. */
const OUTSIDER = "u_team_outsider";
const OTHER_AGENCY = "ag_team_other";

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  users = await import("../src/server/repos/users");

  await db.seed(`
    INSERT INTO agencies (id, name) VALUES ('${OTHER_AGENCY}', 'Rival Agency')
      ON CONFLICT DO NOTHING;`);
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

/**
 * A fresh cast each time, so one test's promotion is not the next one's start.
 *
 * `u_test_a` is demoted deliberately. The shared harness seeds it as an OWNER of
 * this agency, which quietly made "the only owner" a lie — the first run of the
 * last-owner tests failed for that reason, and the guard was right while the
 * fixture was wrong. Stated here rather than assumed.
 *
 * Deleted by email as well as by id: one test creates a replacement account with
 * a generated id, and the unique index on the address is what the next seed
 * collides with.
 */
beforeEach(() =>
  db.seed(`
    UPDATE users SET role = 'member' WHERE id = '${USER_A}';
    DELETE FROM users WHERE id IN
      ('${OWNER}', '${SECOND_OWNER}', '${ADMIN}', '${MEMBER}', '${OUTSIDER}')
       OR email IN ('owner@team.test', 'owner2@team.test', 'admin@team.test',
                    'member@team.test', 'outsider@team.test');
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role) VALUES
      ('${OWNER}',    '${AGENCY}',       NULL, 'owner@team.test',    'x', 'The Owner',   'owner'),
      ('${ADMIN}',    '${AGENCY}',       NULL, 'admin@team.test',    'x', 'The Admin',   'admin'),
      ('${MEMBER}',   '${AGENCY}',       NULL, 'member@team.test',   'x', 'The Member',  'member'),
      ('${OUTSIDER}', '${OTHER_AGENCY}', NULL, 'outsider@team.test', 'x', 'The Rival',   'owner');`)
);

const addSecondOwner = () =>
  db.seed(`
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role)
    VALUES ('${SECOND_OWNER}', '${AGENCY}', NULL, 'owner2@team.test', 'x', 'Co Owner', 'owner')`);

const roleOf = (id: string) =>
  withSystem((q) =>
    q.one<{ role: string; deleted_at: Date | null }>(
      `SELECT role, deleted_at FROM users WHERE id = $1`,
      [id]
    )
  );

describe("changing a role", () => {
  it("promotes a member to admin", async () => {
    const updated = await withSystem((q) => users.setUserRole(q, AGENCY, MEMBER, "admin"));
    expect(updated?.role).toBe("admin");
    expect((await roleOf(MEMBER))?.role).toBe("admin");
  });

  it("refuses a user id belonging to another agency", async () => {
    const updated = await withSystem((q) => users.setUserRole(q, AGENCY, OUTSIDER, "member"));
    expect(updated).toBeNull();
    // The important half: not merely refused, but unchanged.
    expect((await roleOf(OUTSIDER))?.role, "the rival was demoted anyway").toBe("owner");
  });

  it("refuses to demote the only owner", async () => {
    const updated = await withSystem((q) => users.setUserRole(q, AGENCY, OWNER, "admin"));
    expect(updated).toBeNull();
    expect((await roleOf(OWNER))?.role).toBe("owner");
  });

  it("allows demoting an owner once there is a second one", async () => {
    await addSecondOwner();
    const updated = await withSystem((q) => users.setUserRole(q, AGENCY, OWNER, "admin"));
    expect(updated?.role).toBe("admin");
    expect((await roleOf(SECOND_OWNER))?.role, "the survivor").toBe("owner");
  });

  it("promoting to owner is never blocked by the last-owner rule", async () => {
    const updated = await withSystem((q) => users.setUserRole(q, AGENCY, ADMIN, "owner"));
    expect(updated?.role).toBe("owner");
  });

  it("re-confirming the only owner as owner is allowed", async () => {
    /*
       The case the `$3 = 'owner'` escape exists for, and the only one that
       distinguishes it. The test above does not: an admin passes
       `role <> 'owner'` regardless, so removing the escape left it green.

       Without it, setting the last owner's role to the role they already have
       is refused — the guard reads "you are the last owner" and never asks
       whether anything was actually being taken away.
    */
    const updated = await withSystem((q) => users.setUserRole(q, AGENCY, OWNER, "owner"));
    expect(updated?.role).toBe("owner");
  });

  it("does not count a deleted colleague as the second owner", async () => {
    await addSecondOwner();
    await db.seed(`UPDATE users SET deleted_at = now() WHERE id = '${SECOND_OWNER}'`);
    const updated = await withSystem((q) => users.setUserRole(q, AGENCY, OWNER, "member"));
    expect(updated).toBeNull();
    expect((await roleOf(OWNER))?.role).toBe("owner");
  });

  it("leaves a deleted user alone", async () => {
    await db.seed(`UPDATE users SET deleted_at = now() WHERE id = '${MEMBER}'`);
    const updated = await withSystem((q) => users.setUserRole(q, AGENCY, MEMBER, "admin"));
    expect(updated).toBeNull();
    expect((await roleOf(MEMBER))?.role).toBe("member");
  });
});

describe("removing somebody", () => {
  it("removes a member", async () => {
    expect(await withSystem((q) => users.removeTeamMember(q, AGENCY, MEMBER))).toBe(true);
    expect((await roleOf(MEMBER))?.deleted_at).not.toBeNull();
  });

  it("refuses a user id belonging to another agency", async () => {
    expect(await withSystem((q) => users.removeTeamMember(q, AGENCY, OUTSIDER))).toBe(false);
    expect((await roleOf(OUTSIDER))?.deleted_at, "the rival was deleted anyway").toBeNull();
  });

  it("refuses to remove the only owner", async () => {
    expect(await withSystem((q) => users.removeTeamMember(q, AGENCY, OWNER))).toBe(false);
    expect((await roleOf(OWNER))?.deleted_at).toBeNull();
  });

  it("allows removing an owner once there is a second one", async () => {
    await addSecondOwner();
    expect(await withSystem((q) => users.removeTeamMember(q, AGENCY, OWNER))).toBe(true);
    expect((await roleOf(SECOND_OWNER))?.deleted_at, "the survivor").toBeNull();
  });

  it("a removed owner no longer counts as one", async () => {
    // Otherwise the last-owner rule could be satisfied by somebody who has
    // already left, and the agency would end up with no live owner at all.
    await addSecondOwner();
    await withSystem((q) => users.removeTeamMember(q, AGENCY, SECOND_OWNER));
    expect(await withSystem((q) => users.removeTeamMember(q, AGENCY, OWNER))).toBe(false);
    expect((await roleOf(OWNER))?.deleted_at).toBeNull();
  });

  it("is idempotent — removing twice is not an error, it is a no", async () => {
    expect(await withSystem((q) => users.removeTeamMember(q, AGENCY, ADMIN))).toBe(true);
    expect(await withSystem((q) => users.removeTeamMember(q, AGENCY, ADMIN))).toBe(false);
  });

  it("frees the email address for a fresh invitation", async () => {
    // Somebody who leaves and comes back should be an invitation, not a
    // support ticket about a unique index.
    await withSystem((q) => users.removeTeamMember(q, AGENCY, MEMBER));
    const { user, error } = await withSystem((q) =>
      users.createUser(q, {
        agencyId: AGENCY,
        email: "member@team.test",
        password: "a-long-enough-password",
        name: "The Member",
        role: "member",
      })
    );
    expect(error).toBeUndefined();
    expect(user?.email).toBe("member@team.test");
  });
});

describe("who is listed", () => {
  it("lists only this agency's live users", async () => {
    await withSystem((q) => users.removeTeamMember(q, AGENCY, MEMBER));
    const list = await withSystem((q) => users.listUsers(q, AGENCY));
    const ids = list.map((u) => u.id);
    expect(ids).toContain(OWNER);
    expect(ids).toContain(ADMIN);
    expect(ids, "a removed colleague").not.toContain(MEMBER);
    expect(ids, "another agency's staff").not.toContain(OUTSIDER);
  });
});
