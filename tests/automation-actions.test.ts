import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A } from "./helpers/pg";

/**
 * Who may change automations, and what a posted form may contain.
 *
 * The form is hidden from members; these prove the ACTION refuses them, and
 * that ids arriving from a browser cannot name somebody outside the workspace.
 */

const as = globalThis as { __automationRole?: string };

vi.mock("@/server/tenant-session", () => ({
  withCurrentTenant: async <T,>(fn: (q: unknown) => Promise<T>) => {
    const pg = await import("./helpers/pg");
    const { withTenant } = await import("../src/server/tenant");
    const role = ((globalThis as { __automationRole?: string }).__automationRole ?? "owner") as "owner";
    return withTenant({ agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role }, (q) => fn(q));
  },
}));
vi.mock("@/server/revalidate", () => ({ revalidateApp: () => {} }));

let db: TestDb;
let actions: typeof import("../src/app/(app)/settings/automation-actions");
let withSystem: typeof import("../src/server/tenant").withSystem;
let closePool: typeof import("../src/server/db").closePool;

const read = <T>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));

const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) f.append(k, one);
  return f;
};

const leadRule = (assignees: string[]) =>
  form({ eventKind: "lead_created", whenSource: "website", actionKind: "assign_owner", assignee: assignees });

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  actions = await import("../src/app/(app)/settings/automation-actions");
  await db.seed(`
    INSERT INTO agencies (id, name) VALUES ('ag_other', 'Another customer');
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role) VALUES
      ('u_sam',   '${AGENCY}',  NULL, 'sam@test.local',   'x', 'Sam Lee',  'member'),
      ('u_kim',   '${AGENCY}',  NULL, 'kim@test.local',   'x', 'Kim Park', 'member'),
      ('u_other', 'ag_other',   NULL, 'other@test.local', 'x', 'Outsider', 'member');
  `);
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  as.__automationRole = "owner";
  await db.seed(`DELETE FROM automation_runs; DELETE FROM automations;`);
});

describe("making an automation", () => {
  it("SAVES A ROTATION IN THE ORDER PEOPLE WERE CHOSEN", async () => {
    const out = await actions.createAutomationAction(undefined, leadRule(["u_kim", "u_sam"]));
    expect(out).toEqual({ ok: "Saved. It applies to leads and deals from now on." });
    const [row] = await read<{ when_source: string; assignee_ids: string[]; sub_account_id: string }>(
      `SELECT when_source, assignee_ids, sub_account_id FROM automations`
    );
    expect(row).toEqual({ when_source: "website", assignee_ids: ["u_kim", "u_sam"], sub_account_id: TENANT_A });
  });

  it("REFUSES A MEMBER, and writes nothing", async () => {
    as.__automationRole = "member";
    const out = await actions.createAutomationAction(undefined, leadRule(["u_sam"]));
    expect(out?.error).toMatch(/manages the team/);
    expect(await read(`SELECT id FROM automations`)).toHaveLength(0);
  });

  it("REFUSES A PERSON FROM ANOTHER CUSTOMER'S ACCOUNT", async () => {
    const out = await actions.createAutomationAction(undefined, leadRule(["u_sam", "u_other"]));
    expect(out?.error).toMatch(/cannot be given leads/);
    expect(await read(`SELECT id FROM automations`)).toHaveLength(0);
  });

  it("says what is wrong with a rule that makes no sense", async () => {
    const out = await actions.createAutomationAction(
      undefined,
      form({ eventKind: "deal_stage_changed", whenStage: "won", actionKind: "move_stage", targetStage: "lost" })
    );
    expect(out?.error).toMatch(/reason only a person can give/);
  });

  it("stops at the per-workspace limit", async () => {
    await db.seed(`
      INSERT INTO automations (id, sub_account_id, event_kind, action_kind, target_stage)
      SELECT 'au_' || n, '${TENANT_A}', 'lead_created', 'move_stage', 'discovery'
        FROM generate_series(1, 25) AS n;`);
    const out = await actions.createAutomationAction(undefined, leadRule(["u_sam"]));
    expect(out?.error).toMatch(/up to 25/);
  });
});

describe("pausing and removing", () => {
  beforeEach(() =>
    db.seed(`
      INSERT INTO automations (id, sub_account_id, event_kind, action_kind, target_stage, updated_at)
      VALUES ('au_1', '${TENANT_A}', 'lead_created', 'move_stage', 'discovery', now() - interval '1 day');`)
  );

  it("turns a rule off, and marks it as looked at", async () => {
    const out = await actions.setAutomationEnabledAction(undefined, form({ id: "au_1", enabled: "false" }));
    expect(out).toEqual({ ok: "Turned off." });
    const [row] = await read<{ enabled: boolean; fresh: boolean }>(
      `SELECT enabled, updated_at > now() - interval '1 minute' AS fresh FROM automations`
    );
    expect(row).toEqual({ enabled: false, fresh: true });
  });

  it("deletes a rule", async () => {
    expect(await actions.deleteAutomationAction(undefined, form({ id: "au_1" }))).toEqual({ ok: "Deleted." });
    expect(await read(`SELECT id FROM automations`)).toHaveLength(0);
  });

  it("REFUSES A MEMBER BOTH", async () => {
    as.__automationRole = "member";
    expect((await actions.setAutomationEnabledAction(undefined, form({ id: "au_1", enabled: "false" })))?.error).toMatch(/manages the team/);
    expect((await actions.deleteAutomationAction(undefined, form({ id: "au_1" })))?.error).toMatch(/manages the team/);
    const [row] = await read<{ enabled: boolean }>(`SELECT enabled FROM automations`);
    expect(row.enabled).toBe(true);
  });

  it("answers plainly for a rule that is not there", async () => {
    expect((await actions.deleteAutomationAction(undefined, form({ id: "au_missing" })))?.error).toMatch(/no longer exists/);
  });
});
