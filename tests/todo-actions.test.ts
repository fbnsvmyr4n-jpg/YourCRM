import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";

/** Tasks through the actions the screens call: what a posted form may do. */

vi.mock("@/server/tenant-session", () => ({
  withCurrentTenant: async <T,>(fn: (q: unknown) => Promise<T>) => {
    const pg = await import("./helpers/pg");
    const { withTenant } = await import("../src/server/tenant");
    return withTenant({ agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role: "owner" as const }, (q) => fn(q));
  },
}));
vi.mock("@/server/revalidate", () => ({ revalidateApp: () => {} }));

let db: TestDb;
let actions: typeof import("../src/app/(app)/tasks/actions");
let withSystem: typeof import("../src/server/tenant").withSystem;
let closePool: typeof import("../src/server/db").closePool;

const read = <T>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  actions = await import("../src/app/(app)/tasks/actions");
  await db.seed(`
    INSERT INTO agencies (id, name) VALUES ('ag_other', 'Another customer');
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role) VALUES
      ('u_sam',   '${AGENCY}', NULL, 'sam@test.local',   'x', 'Sam Lee',  'member'),
      ('u_it',    '${AGENCY}', NULL, 'it@test.local',    'x', 'Ira Tech', 'admin'),
      ('u_other', 'ag_other',  NULL, 'other@test.local', 'x', 'Outsider', 'member');
  `);
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM todos; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES
      ('ct_a', '${TENANT_A}', 'Amara', 'Dube'),
      ('ct_b', '${TENANT_B}', 'Bruno', 'Beta');
  `)
);

describe("adding a task", () => {
  it("adds one for a contact, with a day and a person", async () => {
    const out = await actions.createTodoAction(
      undefined,
      form({ title: "Call Amara back", dueOn: "2026-09-18", assignee: "u_sam", contactId: "ct_a" })
    );
    expect(out).toEqual({ ok: "Task added." });
    const [t] = await read<{ title: string; due_on: string; assignee_user_id: string; contact_id: string; created_by_user_id: string }>(
      `SELECT title, due_on::text AS due_on, assignee_user_id, contact_id, created_by_user_id FROM todos`
    );
    expect(t).toEqual({ title: "Call Amara back", due_on: "2026-09-18", assignee_user_id: "u_sam", contact_id: "ct_a", created_by_user_id: USER_A });
  });

  it.each([
    ["no wording", { title: "  " }, /what needs doing/],
    ["a date that is not a day", { title: "X", dueOn: "2026-02-30" }, /not a real day/],
    ["somebody from another customer's account", { title: "X", assignee: "u_other" }, /cannot be given tasks/],
    ["the IT administrator, who cannot open a lead", { title: "X", assignee: "u_it" }, /cannot be given tasks/],
  ])("REFUSES %s, and writes nothing", async (_what, fields, pattern) => {
    const out = await actions.createTodoAction(undefined, form(fields as Record<string, string>));
    expect(out?.error).toMatch(pattern);
    expect(await read(`SELECT id FROM todos`)).toHaveLength(0);
  });

  it("REFUSES ANOTHER WORKSPACE'S CONTACT WITH A SENTENCE, not a broken request", async () => {
    const out = await actions.createTodoAction(undefined, form({ title: "Snoop", contactId: "ct_b" }));
    expect(out).toEqual({ error: "That record could not be found." });
    expect(await read(`SELECT id FROM todos`)).toHaveLength(0);
  });
});

describe("working a task", () => {
  beforeEach(() =>
    db.seed(`INSERT INTO todos (id, sub_account_id, title, due_on) VALUES ('td_1', '${TENANT_A}', 'Chase deposit', '2026-09-10');`)
  );

  it("ticks off and back", async () => {
    expect(await actions.setTodoDoneAction("td_1", true)).toEqual({ ok: true });
    expect((await read<{ done: boolean }>(`SELECT done_at IS NOT NULL AS done FROM todos`))[0].done).toBe(true);
    expect(await actions.setTodoDoneAction("td_1", false)).toEqual({ ok: true });
    expect((await read<{ done: boolean }>(`SELECT done_at IS NOT NULL AS done FROM todos`))[0].done).toBe(false);
  });

  it("refuses a tick that is not a yes or no", async () => {
    expect(await actions.setTodoDoneAction("td_1", "yes" as unknown as boolean)).toEqual({ ok: false });
  });

  it("edits, clearing the day and the person", async () => {
    const out = await actions.updateTodoAction(undefined, form({ id: "td_1", title: "Chase the deposit", dueOn: "", assignee: "" }));
    expect(out).toEqual({ ok: "Saved." });
    const [t] = await read<{ title: string; due_on: string | null; assignee_user_id: string | null }>(
      `SELECT title, due_on, assignee_user_id FROM todos`
    );
    expect(t).toEqual({ title: "Chase the deposit", due_on: null, assignee_user_id: null });
  });

  it("deletes, and says so plainly the second time", async () => {
    expect(await actions.deleteTodoAction(undefined, form({ id: "td_1" }))).toEqual({ ok: "Deleted." });
    expect(await actions.deleteTodoAction(undefined, form({ id: "td_1" }))).toEqual({ error: "That task no longer exists." });
  });
});
