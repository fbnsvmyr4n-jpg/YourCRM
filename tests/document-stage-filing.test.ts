import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, TENANT_A } from "./helpers/pg";

/**
 * Raising a purchase order for one stage of the job.
 *
 * Before this, a line could only be filed to a stage by the app itself — the
 * plan builder and the invoice raiser set it, and nothing a person could press
 * did. A supplier's order typed in by hand therefore never counted against the
 * stage it paid for, and every stage's margin on a normally-run job was
 * quietly wrong.
 *
 * The property that matters most: a stage from ANOTHER project is refused
 * before anything is written, so a mistake leaves no half-saved document and
 * never puts one job's costs in another job's margin.
 */

vi.mock("@/server/tenant-session", () => ({
  requireTenant: async () => {
    const pg = await import("./helpers/pg");
    return { agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role: "owner" };
  },
  withCurrentTenant: async <T,>(fn: (q: unknown) => Promise<T>) => {
    const pg = await import("./helpers/pg");
    const { withTenant } = await import("../src/server/tenant");
    return withTenant(
      { agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role: "owner" as const },
      (q) => fn(q)
    );
  },
}));
vi.mock("@/server/revalidate", () => ({ revalidateApp: () => {} }));

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let createDocumentAction: typeof import("../src/app/(app)/projects/actions").createDocumentAction;
let closePool: typeof import("../src/server/db").closePool;
let ctx: import("../src/server/tenant").TenantContext;

beforeAll(async () => {
  db = await startTestDb();
  const pg = await import("./helpers/pg");
  ctx = { agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role: "owner" };
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  ({ createDocumentAction } = await import("../src/app/(app)/projects/actions"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM document_lines; DELETE FROM documents; DELETE FROM project_tasks;
    DELETE FROM deals; DELETE FROM contacts; DELETE FROM companies;
    INSERT INTO companies (id, sub_account_id, name) VALUES ('co_s', '${TENANT_A}', 'Heineken');
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, company_id)
      VALUES ('ct_s', '${TENANT_A}', 'Amara', 'Dube', 'amara@heineken.test', 'co_s');
    INSERT INTO deals (id, sub_account_id, company_id, contact_id, title, value_cents, stage) VALUES
      ('d_one', '${TENANT_A}', 'co_s', 'ct_s', 'Rebuild warehouse', 1800000_00, 'discovery'),
      ('d_two', '${TENANT_A}', 'co_s', 'ct_s', 'Another job', 500000_00, 'discovery');
    INSERT INTO project_tasks (id, sub_account_id, deal_id, name) VALUES
      ('t_crane', '${TENANT_A}', 'd_one', 'Crane hire'),
      ('t_elsewhere', '${TENANT_A}', 'd_two', 'A stage on the other job');
  `)
);

const po = (fields: Record<string, string>, lines: [string, string, string][]) => {
  const f = new FormData();
  f.set("dealId", "d_one");
  f.set("kind", "purchase_order");
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const [description, quantity, unit] of lines) {
    f.append("lineDescription", description);
    f.append("lineQuantity", quantity);
    f.append("lineUnit", unit);
  }
  return f;
};

const rows = <T,>(sql: string) =>
  withTenant(ctx, (q) => q.rows<T & Record<string, unknown>>(sql));

describe("a purchase order raised for a stage", () => {
  it("FILES EVERY LINE TO THAT STAGE, AND SAYS SO", async () => {
    const out = await createDocumentAction(
      undefined,
      po({ number: "PO-10", projectTaskId: "t_crane" }, [
        ["Mobile crane, 3 days", "3", "12000"],
        ["Rigger", "3", "2500"],
      ])
    );
    expect(out?.ok).toBe("PO-10 saved with 2 lines, filed to Crane hire.");

    const filed = await rows<{ project_task_id: string | null }>(
      `SELECT project_task_id FROM document_lines ORDER BY position`
    );
    expect(filed.map((r) => r.project_task_id)).toEqual(["t_crane", "t_crane"]);
  });

  it("REFUSES A STAGE FROM ANOTHER PROJECT, AND LEAVES NOTHING HALF-SAVED", async () => {
    const out = await createDocumentAction(
      undefined,
      po({ number: "PO-11", projectTaskId: "t_elsewhere" }, [["Steel", "1", "100"]])
    );
    expect(out).toEqual({ error: "That stage is not part of this project." });
    expect(await rows(`SELECT id FROM documents`), "a document was written without its lines").toHaveLength(0);
    expect(await rows(`SELECT id FROM document_lines`)).toHaveLength(0);
  });

  it("refuses a stage that does not exist", async () => {
    const out = await createDocumentAction(
      undefined,
      po({ number: "PO-12", projectTaskId: "t_nobody" }, [["Steel", "1", "100"]])
    );
    expect(out).toEqual({ error: "That stage is not part of this project." });
    expect(await rows(`SELECT id FROM documents`)).toHaveLength(0);
  });

  it("refuses a stage that has been deleted from the plan", async () => {
    /* Found by a mutation run: dropping the deleted check changed nothing any
       test could see. A deleted stage is off the Timeline, so a purchase order
       filed to it would count against a stage nobody can open. */
    await db.seed(`UPDATE project_tasks SET deleted_at = now() WHERE id = 't_crane'`);
    const out = await createDocumentAction(
      undefined,
      po({ number: "PO-15", projectTaskId: "t_crane" }, [["Steel", "1", "100"]])
    );
    expect(out).toEqual({ error: "That stage is not part of this project." });
    expect(await rows(`SELECT id FROM documents`)).toHaveLength(0);
  });

  it("refuses a stage id that is not an id at all", async () => {
    const out = await createDocumentAction(
      undefined,
      po({ number: "PO-13", projectTaskId: "t_crane' OR '1'='1" }, [["Steel", "1", "100"]])
    );
    expect(out).toEqual({ error: "That stage could not be identified." });
  });

  it("leaves lines unfiled when no stage was chosen, exactly as before", async () => {
    const out = await createDocumentAction(undefined, po({ number: "PO-14" }, [["Steel", "1", "100"]]));
    expect(out?.ok).toBe("PO-14 saved with 1 line.");
    const filed = await rows<{ project_task_id: string | null }>(`SELECT project_task_id FROM document_lines`);
    expect(filed.map((r) => r.project_task_id)).toEqual([null]);
  });
});
