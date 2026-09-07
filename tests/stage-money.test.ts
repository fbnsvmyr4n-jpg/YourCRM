import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  documentsForStage,
  orderCounts,
  quoteCounts,
  stageMoney,
  unfiledLineCount,
} from "../src/server/stage-money";
import type { ProjectDocument } from "../src/server/repos/projects";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * What each stage of a job was charged for, and what it has cost.
 *
 * The project header has always answered this for the whole job. What it could
 * not answer is WHERE the margin went, because nothing said which stage a
 * document line belonged to — and "this job is at 22%" tells you to worry
 * while "steel erection is at −4%" tells you what to do.
 *
 * The arithmetic is tested against figures worked out by hand, and the rules
 * about which documents count are tested because they are ASYMMETRIC on
 * purpose: money we might receive must be certain before it counts, money we
 * might owe counts before it is certain.
 */

const line = (id: string, total: number, taskId: string | null) => ({
  id,
  description: id,
  quantity: 1,
  unitCents: total,
  totalCents: total,
  projectTaskId: taskId,
});

const doc = (
  id: string,
  kind: ProjectDocument["kind"],
  status: ProjectDocument["status"],
  lines: ReturnType<typeof line>[]
): ProjectDocument => ({
  id,
  kind,
  number: id.toUpperCase(),
  status,
  party: null,
  issuedOn: null,
  dueOn: null,
  notes: null,
  lines,
  totalCents: lines.reduce((n, l) => n + l.totalCents, 0),
});

describe("which documents move the money", () => {
  it("counts a quotation only once the client has agreed", () => {
    /* A quotation that has merely been sent is a hope, and a margin built on
       hopes reads as fact next to real numbers. */
    expect(quoteCounts("accepted")).toBe(true);
    expect(quoteCounts("paid")).toBe(true);
    for (const s of ["draft", "awaiting_approval", "approved", "sent", "declined", "cancelled"] as const) {
      expect(quoteCounts(s), s).toBe(false);
    }
  });

  it("counts a purchase order until it is called off", () => {
    /*
       The opposite default, and the asymmetry is the point. A draft PO is a
       commitment somebody has decided to make; leaving it out until it is sent
       would make a stage look profitable right up to the moment it is not.
    */
    for (const s of ["draft", "awaiting_approval", "approved", "sent", "accepted", "paid"] as const) {
      expect(orderCounts(s), s).toBe(true);
    }
    expect(orderCounts("cancelled")).toBe(false);
    expect(orderCounts("declined")).toBe(false);
  });
});

describe("a stage's money", () => {
  it("is what the client was charged less what was ordered against it", () => {
    // Crane hire: quoted 36,000, ordered 28,000 → margin 8,000. By hand.
    const docs = [
      doc("q1", "quote", "accepted", [line("crane", 3_600_000, "t_crane")]),
      doc("po1", "purchase_order", "sent", [line("crane-supplier", 2_800_000, "t_crane")]),
    ];
    expect(stageMoney(docs).get("t_crane")).toEqual({
      quotedCents: 3_600_000,
      committedCents: 2_800_000,
      marginCents: 800_000,
      documents: 2,
    });
  });

  it("shows a stage being done at a loss as a negative, not a zero", () => {
    /* The whole reason to look. Clamping it at zero would hide the one stage
       somebody needs to act on. */
    const docs = [
      doc("q1", "quote", "accepted", [line("steel", 1_000_000, "t_steel")]),
      doc("po1", "purchase_order", "sent", [line("steel-supplier", 1_400_000, "t_steel")]),
    ];
    expect(stageMoney(docs).get("t_steel")?.marginCents).toBe(-400_000);
  });

  it("splits one quotation across the stages its lines belong to", () => {
    /*
       The reason the link is on the LINE. A client quotation covers every
       stage at once, so a document-level link could only ever describe
       purchase orders.
    */
    const docs = [
      doc("q1", "quote", "accepted", [
        line("survey", 125_050, "t_survey"),
        line("crane", 3_600_000, "t_crane"),
      ]),
    ];
    const money = stageMoney(docs);
    expect(money.get("t_survey")?.quotedCents).toBe(125_050);
    expect(money.get("t_crane")?.quotedCents).toBe(3_600_000);
  });

  it("counts a document once per stage however many of its lines are there", () => {
    /* A purchase order with three lines against one stage is one piece of
       paperwork, and "3 documents" on that stage would be a lie. */
    const docs = [
      doc("po1", "purchase_order", "sent", [
        line("crane", 100, "t_crane"),
        line("operator", 200, "t_crane"),
        line("transport", 300, "t_crane"),
      ]),
    ];
    const stage = stageMoney(docs).get("t_crane");
    expect(stage?.documents).toBe(1);
    expect(stage?.committedCents).toBe(600);
  });

  it("leaves an invoice out of the arithmetic", () => {
    /* An invoice is the same money as its quotation seen later. Counting it
       would double what the client was charged. */
    const docs = [
      doc("q1", "quote", "accepted", [line("crane", 3_600_000, "t_crane")]),
      doc("inv1", "invoice", "paid", [line("crane-invoice", 3_600_000, "t_crane")]),
    ];
    const stage = stageMoney(docs).get("t_crane");
    expect(stage?.quotedCents).toBe(3_600_000);
    /*
       And crucially it is not a COST either. Mutation testing caught this
       version of the test asserting only the revenue side: treating an invoice
       as a purchase order left it green, while every stage on every job would
       have shown a loss the size of its own invoice.
    */
    expect(stage?.committedCents, "an invoice was counted as money owed").toBe(0);
    expect(stage?.marginCents).toBe(3_600_000);
    /* It still counts as paperwork on the stage, because it is. */
    expect(stage?.documents).toBe(2);
  });

  it("ignores a cancelled order entirely", () => {
    const docs = [
      doc("po1", "purchase_order", "cancelled", [line("crane", 2_800_000, "t_crane")]),
    ];
    expect(stageMoney(docs).get("t_crane")?.committedCents).toBe(0);
  });

  it("says nothing about a stage nothing was filed against", () => {
    /* An absent entry, not a row of zeros — a stage with no paperwork has no
       margin, and showing "0%" would be an assertion nobody made. */
    const docs = [doc("q1", "quote", "accepted", [line("crane", 100, null)])];
    expect(stageMoney(docs).size).toBe(0);
  });
});

describe("which documents belong to a stage", () => {
  it("shows only the lines that are on that stage", () => {
    const q1 = doc("q1", "quote", "accepted", [
      line("survey", 125_050, "t_survey"),
      line("crane", 3_600_000, "t_crane"),
    ]);
    const found = documentsForStage([q1], "t_crane");
    expect(found).toHaveLength(1);
    expect(found[0].lines.map((l) => l.id)).toEqual(["crane"]);
  });

  it("leaves out a document with nothing on that stage", () => {
    const docs = [doc("q1", "quote", "accepted", [line("survey", 1, "t_survey")])];
    expect(documentsForStage(docs, "t_crane")).toEqual([]);
  });

  it("counts the lines nobody has filed, so the screen can offer to", () => {
    const docs = [
      doc("q1", "quote", "accepted", [line("a", 1, "t_crane"), line("b", 1, null)]),
      doc("po1", "purchase_order", "draft", [line("c", 1, null)]),
    ];
    expect(unfiledLineCount(docs)).toBe(2);
  });
});

/* ---------- the guard that stops one job's costs reaching another ---------- */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let closePool: typeof import("../src/server/db").closePool;

const CTX: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(CTX, fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM document_lines; DELETE FROM documents;
    DELETE FROM project_tasks; DELETE FROM deals;

    INSERT INTO deals (id, sub_account_id, title, value_cents, stage) VALUES
      ('d_one', '${TENANT_A}', 'Warehouse', 100, 'won'),
      ('d_two', '${TENANT_A}', 'Something else', 100, 'won');

    INSERT INTO project_tasks (id, sub_account_id, deal_id, name) VALUES
      ('t_one', '${TENANT_A}', 'd_one', 'Crane hire'),
      ('t_two', '${TENANT_A}', 'd_two', 'A stage on the other job');

    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status)
    VALUES ('doc_one', '${TENANT_A}', 'd_one', 'purchase_order', 'PO-1', 'sent');

    INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents)
    VALUES ('l_one', '${TENANT_A}', 'doc_one', 'Crane', 1, 100);`)
);

describe("filing a line against a stage", () => {
  it("accepts a stage on the same project", async () => {
    await inA((q) =>
      q.rows(`UPDATE document_lines SET project_task_id = 't_one' WHERE id = 'l_one'`)
    );
    const row = await inA((q) =>
      q.one<{ project_task_id: string | null }>(
        `SELECT project_task_id FROM document_lines WHERE id = 'l_one'`
      )
    );
    expect(row?.project_task_id).toBe("t_one");
  });

  it("REFUSES a stage on a different project", async () => {
    /*
       Row-level security cannot catch this and could not: the write targets a
       row in this tenant and is legitimately allowed — only the value is
       wrong. The result would be one job's costs counted against another
       job's margin, which is a number somebody would act on.
    */
    await expect(
      inA((q) => q.rows(`UPDATE document_lines SET project_task_id = 't_two' WHERE id = 'l_one'`))
    ).rejects.toThrow(/different project/);
  });

  it("allows unfiling, always", async () => {
    await inA((q) =>
      q.rows(`UPDATE document_lines SET project_task_id = 't_one' WHERE id = 'l_one'`)
    );
    await inA((q) =>
      q.rows(`UPDATE document_lines SET project_task_id = NULL WHERE id = 'l_one'`)
    );
    const row = await inA((q) =>
      q.one<{ project_task_id: string | null }>(
        `SELECT project_task_id FROM document_lines WHERE id = 'l_one'`
      )
    );
    expect(row?.project_task_id).toBeNull();
  });

  it("keeps the line when its stage is deleted", async () => {
    /*
       SET NULL, never CASCADE. A quote line is the financial record of what a
       client was charged; deleting a task from a plan must not delete the
       money along with it.
    */
    await inA((q) =>
      q.rows(`UPDATE document_lines SET project_task_id = 't_one' WHERE id = 'l_one'`)
    );
    await db.seed(`DELETE FROM project_tasks WHERE id = 't_one'`);

    const row = await inA((q) =>
      q.one<{ id: string; project_task_id: string | null }>(
        `SELECT id, project_task_id FROM document_lines WHERE id = 'l_one'`
      )
    );
    expect(row?.id, "the line was deleted with the task").toBe("l_one");
    expect(row?.project_task_id).toBeNull();
  });
});
