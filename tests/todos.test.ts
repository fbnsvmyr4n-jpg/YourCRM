import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/** Tasks on a real Postgres: what is listed, finished, counted and refused. */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let repo: typeof import("../src/server/repos/todos");
let closePool: typeof import("../src/server/db").closePool;

const ctxA: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctxA, fn);
const TODAY = "2026-09-16";
/** Today in the default workspace zone, as SQL. See the note where it is used. */
const UTC_TODAY = "(now() AT TIME ZONE 'UTC')::date";

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/todos");
  await db.seed(`
    INSERT INTO agencies (id, name) VALUES ('ag_other', 'Another customer');
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role) VALUES
      ('u_sam',   '${AGENCY}',  NULL, 'sam@test.local',   'x', 'Sam Lee',  'member'),
      ('u_other', 'ag_other',   NULL, 'other@test.local', 'x', 'Outsider', 'member');
  `);
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM todos; DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES
      ('ct_a', '${TENANT_A}', 'Amara', 'Dube'),
      ('ct_b', '${TENANT_B}', 'Bruno', 'Beta');
    INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage) VALUES
      ('d_a', '${TENANT_A}', 'ct_a', 'Warehouse', 0, 'discovery');
  `)
);

describe("making and reading tasks", () => {
  it("CREATES A TASK WITH ITS PEOPLE AND RECORDS NAMED", async () => {
    const t = await inA((q) =>
      repo.createTodo(q, {
        title: "Call Amara back",
        dueOn: TODAY,
        assigneeUserId: "u_sam",
        contactId: "ct_a",
        dealId: "d_a",
      })
    );
    expect(t).toMatchObject({
      title: "Call Amara back",
      dueOn: TODAY,
      assigneeName: "Sam Lee",
      contactName: "Amara Dube",
      dealTitle: "Warehouse",
      createdByUserId: USER_A,
      automationId: null,
      doneAt: null,
    });
  });

  it("filters to one contact or one deal", async () => {
    await inA((q) => repo.createTodo(q, { title: "For Amara", contactId: "ct_a" }));
    await inA((q) => repo.createTodo(q, { title: "Unlinked" }));
    expect((await inA((q) => repo.listTodos(q, { contactId: "ct_a" }))).map((t) => t.title)).toEqual(["For Amara"]);
    expect(await inA((q) => repo.listTodos(q, { dealId: "d_a" }))).toEqual([]);
  });

  it("keeps a finished task on the list for a week, then lets it go", async () => {
    const t = await inA((q) => repo.createTodo(q, { title: "Old" }));
    await inA((q) => repo.setTodoDone(q, t.id, true));
    expect(await inA((q) => repo.listTodos(q))).toHaveLength(1);
    await db.seed(`UPDATE todos SET done_at = now() - interval '8 days'`);
    expect(await inA((q) => repo.listTodos(q))).toHaveLength(0);
  });

  it("does not list a deleted task", async () => {
    const t = await inA((q) => repo.createTodo(q, { title: "Gone" }));
    expect(await inA((q) => repo.deleteTodo(q, t.id))).toBe(true);
    expect(await inA((q) => repo.listTodos(q))).toEqual([]);
    expect(await inA((q) => repo.deleteTodo(q, t.id)), "deleting twice claimed success").toBe(false);
  });
});

describe("ticking off", () => {
  it("RECORDS WHO FINISHED IT, and unticking clears both", async () => {
    const t = await inA((q) => repo.createTodo(q, { title: "Send drawings" }));
    await inA((q) => repo.setTodoDone(q, t.id, true));
    const [done] = await withTenant(ctxA, (q) =>
      q.rows<{ done_at: Date | null; done_by_user_id: string | null }>(
        `SELECT done_at, done_by_user_id FROM todos WHERE sub_account_id = $1`, [TENANT_A])
    );
    expect(done.done_at).not.toBeNull();
    expect(done.done_by_user_id).toBe(USER_A);

    await inA((q) => repo.setTodoDone(q, t.id, false));
    expect((await inA((q) => repo.getTodo(q, t.id)))?.doneAt).toBeNull();
  });

  it("ticking twice keeps the first finish time rather than moving it", async () => {
    const t = await inA((q) => repo.createTodo(q, { title: "Once" }));
    await inA((q) => repo.setTodoDone(q, t.id, true));
    await db.seed(`UPDATE todos SET done_at = '2026-09-01T09:00:00Z'`);
    await inA((q) => repo.setTodoDone(q, t.id, true));
    expect((await inA((q) => repo.getTodo(q, t.id)))?.doneAt).toBe("2026-09-01T09:00:00.000Z");
  });
});

describe("what is due", () => {
  it("COUNTS ONE PERSON'S OPEN TASKS DUE TODAY AND ALREADY LATE, and nothing else", async () => {
    await db.seed(`
      INSERT INTO todos (id, sub_account_id, title, due_on, assignee_user_id, done_at) VALUES
        ('t1', '${TENANT_A}', 'late',        '2026-09-10', 'u_sam', NULL),
        ('t2', '${TENANT_A}', 'late too',    '2026-09-15', 'u_sam', NULL),
        ('t3', '${TENANT_A}', 'today',       '${TODAY}',   'u_sam', NULL),
        ('t4', '${TENANT_A}', 'tomorrow',    '2026-09-17', 'u_sam', NULL),
        ('t5', '${TENANT_A}', 'done late',   '2026-09-10', 'u_sam', now()),
        ('t6', '${TENANT_A}', 'someone else','2026-09-10', '${USER_A}', NULL),
        ('t7', '${TENANT_A}', 'no day',      NULL,         'u_sam', NULL);
      INSERT INTO todos (id, sub_account_id, title, due_on, assignee_user_id, deleted_at) VALUES
        ('t8', '${TENANT_A}', 'deleted late','2026-09-10', 'u_sam', now());
    `);
    expect(await inA((q) => repo.dueForUser(q, "u_sam", TODAY))).toEqual({ dueToday: 1, overdue: 2 });
  });
});

describe("where late work is announced", () => {
  it("THE BELL RINGS FOR MY LATE TASKS ONLY, and the sidebar counts today's too", async () => {
    const notifications = await import("../src/server/notifications");
    const { navCounts } = await import("../src/server/nav-counts");
    /* Relative to TODAY IN UTC, the default workspace zone — NOT `CURRENT_DATE`.
       `CURRENT_DATE` is the database session's local day, and this test failed
       for the two hours after midnight in Johannesburg, when the machine's day
       had already turned and the workspace's had not. The app was right; the
       test was asking a different clock. */
    await db.seed(`
      INSERT INTO todos (id, sub_account_id, title, due_on, assignee_user_id) VALUES
        ('m1', '${TENANT_A}', 'mine, late',   ${UTC_TODAY} - 2, '${USER_A}'),
        ('m2', '${TENANT_A}', 'mine, today',  ${UTC_TODAY},     '${USER_A}'),
        ('s1', '${TENANT_A}', 'Sam''s, late', ${UTC_TODAY} - 5, 'u_sam');
    `);
    const feed = await inA((q) => notifications.listNotifications(q));
    const item = feed.find((n) => n.id === "tasks-overdue");
    expect(item?.title, "a colleague's late task counted against me").toBe("1 of your tasks is overdue");
    expect(item?.href).toBe("/tasks");

    const counts = await inA((q) => navCounts(q));
    expect(counts.tasksDue, "the badge must count today's tasks as well as late ones").toBe(2);
  });

  it("stays quiet when nothing of mine is late", async () => {
    const notifications = await import("../src/server/notifications");
    await db.seed(`
      INSERT INTO todos (id, sub_account_id, title, due_on, assignee_user_id) VALUES
        ('m2', '${TENANT_A}', 'mine, today', ${UTC_TODAY}, '${USER_A}');`);
    const feed = await inA((q) => notifications.listNotifications(q));
    expect(feed.find((n) => n.id === "tasks-overdue")).toBeUndefined();
  });
});

describe("what the database refuses", () => {
  /* One refusal per test — see the PGlite desync note in the failure log. */
  it("REFUSES AN ASSIGNEE FROM ANOTHER CUSTOMER'S ACCOUNT", async () => {
    await expect(
      db.seed(`INSERT INTO todos (id, sub_account_id, title, assignee_user_id) VALUES ('x', '${TENANT_A}', 'x', 'u_other')`)
    ).rejects.toThrow(/assignee u_other does not belong/);
  });

  it("REFUSES ANOTHER WORKSPACE'S CONTACT", async () => {
    await expect(
      db.seed(`INSERT INTO todos (id, sub_account_id, title, contact_id) VALUES ('x', '${TENANT_A}', 'x', 'ct_b')`)
    ).rejects.toThrow(/contact ct_b does not belong/);
  });

  it("refuses an empty title", async () => {
    await expect(
      db.seed(`INSERT INTO todos (id, sub_account_id, title) VALUES ('x', '${TENANT_A}', '   ')`)
    ).rejects.toThrow(/todos_title_check/);
  });
});
