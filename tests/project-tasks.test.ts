import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * A project's schedule.
 *
 * The figure that matters is the rollup, and it is the one most easily made to
 * lie: a plain average of percentages reports a job half done when the ten-day
 * task has not started and the half-day one is finished. The arithmetic is
 * right and the answer is wrong, which is the worst kind of number to put on a
 * screen somebody plans from. So it is weighted by duration, and the fixture
 * below is sized so every expected figure was worked out by hand first.
 *
 * The other trap is the DATE, which this codebase has fallen into before: a
 * calendar day read as a timestamp and formatted in a zone behind UTC comes
 * back a day early. Dates here are compared as strings for that reason.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let tasks: typeof import("../src/server/repos/tasks");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

const JOB = "d_warehouse";
const OTHER_JOB = "d_other_tenant";

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  tasks = await import("../src/server/repos/tasks");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM workspace_holidays;
    DELETE FROM project_tasks; DELETE FROM deals; DELETE FROM contacts; DELETE FROM companies;

    INSERT INTO companies (id, sub_account_id, name) VALUES
      ('co_heineken', '${TENANT_A}', 'Heineken');

    INSERT INTO deals (id, sub_account_id, company_id, title, value_cents, stage) VALUES
      ('${JOB}',       '${TENANT_A}', 'co_heineken', 'Rebuild warehouse', 1800000_00, 'delivery'),
      ('${OTHER_JOB}', '${TENANT_B}', NULL,          'Another tenant''s job', 1000_00, 'discovery');`)
);

const add = (name: string, startsOn: string | null, dueOn: string | null, percent = 0) =>
  inA((q) => tasks.addTask(q, JOB, { name, startsOn, dueOn, percentComplete: percent }));

describe("what a task is", () => {
  it("stores the calendar day it was given, not a day either side of it", async () => {
    const { task } = await add("Radial arm drilling machine", "2026-09-01", "2026-09-02");
    expect(task?.startsOn).toBe("2026-09-01");
    expect(task?.dueOn).toBe("2026-09-02");
    expect(task?.durationDays).toBe(2);
  });

  it("treats a same-day task as one day", async () => {
    const { task } = await add("Phase finish", "2026-08-24", "2026-08-24");
    expect(task?.durationDays).toBe(1);
  });

  it("leaves duration unknown when a date is missing", async () => {
    const { task } = await add("Unscheduled", null, null);
    expect(task?.durationDays).toBeNull();
  });

  it("refuses a task that finishes before it starts", async () => {
    const { error } = await add("Backwards", "2026-09-10", "2026-09-01");
    expect(error).toMatch(/finishes before it starts/i);
  });

  it("refuses a task with no name", async () => {
    const { error } = await add("   ", "2026-09-01", "2026-09-02");
    expect(error).toMatch(/give the task a name/i);
  });

  it("keeps the plan's order rather than re-sorting by date", async () => {
    await add("Second in the plan", "2026-09-10", "2026-09-11");
    await add("First in the plan", "2026-09-01", "2026-09-02");
    const list = await inA((q) => tasks.listTasks(q, JOB));
    // Added second, dated earlier — and it stays where it was put.
    expect(list.map((t) => t.name)).toEqual(["Second in the plan", "First in the plan"]);
  });
});

describe("finishing a task", () => {
  it("stamps when it reached a hundred", async () => {
    const { task } = await add("Lathe", "2026-09-01", "2026-09-02");
    expect(task?.doneAt).toBeNull();

    const done = await inA((q) => tasks.setTaskComplete(q, task!.id, true));
    expect(done.task?.percentComplete).toBe(100);
    expect(done.task?.doneAt).not.toBeNull();
  });

  it("clears the stamp when it is reopened", async () => {
    const { task } = await add("Milling machine", "2026-09-01", "2026-09-02", 100);
    expect(task?.doneAt).not.toBeNull();

    const reopened = await inA((q) => tasks.setTaskComplete(q, task!.id, false));
    expect(reopened.task?.percentComplete).toBe(0);
    expect(reopened.task?.doneAt).toBeNull();
  });

  it("does not move the completion date when a finished task is edited", async () => {
    /* Fixing a typo in the name of a task finished a fortnight ago must not
       report it as finished today. */
    const { task } = await add("Angle grinder", "2026-09-01", "2026-09-02", 100);
    const first = task!.doneAt;

    const edited = await inA((q) =>
      tasks.updateTask(q, task!.id, {
        name: "Angle grinder (bench)",
        startsOn: "2026-09-01",
        dueOn: "2026-09-02",
        percentComplete: 100,
      })
    );
    expect(edited.task?.name).toBe("Angle grinder (bench)");
    expect(edited.task?.doneAt).toBe(first);
  });

  it("clamps a percentage rather than storing nonsense", async () => {
    const { task } = await add("Hand drills", "2026-09-09", "2026-09-10", 300);
    expect(task?.percentComplete).toBe(100);
    const low = await inA((q) =>
      tasks.updateTask(q, task!.id, { name: "Hand drills", percentComplete: -50 })
    );
    expect(low.task?.percentComplete).toBe(0);
  });
});

describe("how far along the project is", () => {
  it("weights by duration rather than averaging percentages", () => {
    /*
       The whole reason this function exists.

       A ten-day task not started and a one-day task finished is 1 day of 11
       done — 9%. A plain average of 0 and 100 says 50%, which would tell
       somebody a job is half built when almost none of it is.
    */
    const list = [
      { durationDays: 10, percentComplete: 0 },
      { durationDays: 1, percentComplete: 100 },
    ] as Parameters<typeof tasks.summarise>[0];

    expect(tasks.summarise(list, "2026-09-01").percentComplete).toBe(9);
  });

  it("counts a task with no dates as a day rather than dropping it", () => {
    const list = [
      { durationDays: null, percentComplete: 100 },
      { durationDays: 1, percentComplete: 0 },
    ] as Parameters<typeof tasks.summarise>[0];
    // One day done of two, not "100% because the other one has no weight".
    expect(tasks.summarise(list, "2026-09-01").percentComplete).toBe(50);
  });

  it("reports the span the plan covers", async () => {
    await add("First", "2026-08-24", "2026-08-25");
    await add("Last", "2026-09-23", "2026-09-28");
    await add("Middle", "2026-09-01", "2026-09-02");
    const list = await inA((q) => tasks.listTasks(q, JOB));
    const summary = tasks.summarise(list, "2026-09-06");
    expect(summary.startsOn).toBe("2026-08-24");
    expect(summary.dueOn).toBe("2026-09-28");
    expect(summary.tasks).toBe(3);
  });

  it("counts an unfinished task past its date as overdue, and a finished one not", async () => {
    await add("Late", "2026-08-01", "2026-08-05", 40);
    await add("Late but done", "2026-08-01", "2026-08-05", 100);
    await add("Still to come", "2026-12-01", "2026-12-05", 0);
    const list = await inA((q) => tasks.listTasks(q, JOB));
    expect(tasks.summarise(list, "2026-09-06").overdue).toBe(1);
  });

  it("says nothing rather than zero when nothing is scheduled", () => {
    const summary = tasks.summarise([], "2026-09-06");
    expect(summary.percentComplete).toBeNull();
    expect(summary.tasks).toBe(0);
  });

  it("counts what is finished", async () => {
    await add("One", "2026-09-01", "2026-09-02", 100);
    await add("Two", "2026-09-03", "2026-09-04", 50);
    const list = await inA((q) => tasks.listTasks(q, JOB));
    expect(tasks.summarise(list, "2026-09-06").done).toBe(1);
  });
});

describe("rearranging the plan", () => {
  it("moves a task up past its neighbour", async () => {
    await add("A", "2026-09-01", "2026-09-02");
    await add("B", "2026-09-03", "2026-09-04");
    await add("C", "2026-09-05", "2026-09-06");
    const before = await inA((q) => tasks.listTasks(q, JOB));

    await inA((q) => tasks.moveTask(q, JOB, before[2].id, "up"));
    const after = await inA((q) => tasks.listTasks(q, JOB));
    expect(after.map((t) => t.name)).toEqual(["A", "C", "B"]);
  });

  it("refuses to move the first task up, or the last down", async () => {
    await add("A", "2026-09-01", "2026-09-02");
    await add("B", "2026-09-03", "2026-09-04");
    const list = await inA((q) => tasks.listTasks(q, JOB));
    expect(await inA((q) => tasks.moveTask(q, JOB, list[0].id, "up"))).toBe(false);
    expect(await inA((q) => tasks.moveTask(q, JOB, list[1].id, "down"))).toBe(false);
  });

  it("reorders tasks that all share a position", async () => {
    /* Every task written before ordering existed carries position 0, and
       swapping two identical numbers moves nothing. Rewriting by index does. */
    await add("A", null, null);
    await add("B", null, null);
    await db.seed(`UPDATE project_tasks SET position = 0`);

    const before = await inA((q) => tasks.listTasks(q, JOB));
    await inA((q) => tasks.moveTask(q, JOB, before[1].id, "up"));
    const after = await inA((q) => tasks.listTasks(q, JOB));
    expect(after.map((t) => t.name)).toEqual([before[1].name, before[0].name]);
  });
});

describe("a task belongs to one project in one workspace", () => {
  it("is invisible to another tenant", async () => {
    const { task } = await add("Ours", "2026-09-01", "2026-09-02");
    expect(await inB((q) => tasks.findTask(q, task!.id))).toBeNull();
    expect(await inB((q) => tasks.listTasks(q, JOB))).toEqual([]);
  });

  it("cannot be added to another tenant's project", async () => {
    const { error } = await inA((q) =>
      tasks.addTask(q, OTHER_JOB, { name: "Sneaky", startsOn: null, dueOn: null })
    );
    expect(error).toMatch(/no longer exists/i);
  });

  it("is refused by the database even without the repository's check", async () => {
    /* The trigger is what makes the rule true of the DATA rather than true of
       one function — a bulk import or a script written next year cannot write
       the row either. */
    await expect(
      db.seed(`INSERT INTO project_tasks (id, sub_account_id, deal_id, name)
               VALUES ('pt_bad', '${TENANT_A}', '${OTHER_JOB}', 'Cross-tenant')`)
    ).rejects.toThrow(/does not belong to sub-account/i);
  });

  it("refuses a backwards date range at the database too", async () => {
    await expect(
      db.seed(`INSERT INTO project_tasks (id, sub_account_id, deal_id, name, starts_on, due_on)
               VALUES ('pt_back', '${TENANT_A}', '${JOB}', 'Backwards',
                       DATE '2026-09-10', DATE '2026-09-01')`)
    ).rejects.toThrow();
  });
});

describe("removing a task", () => {
  it("takes it off the plan without erasing that it was planned", async () => {
    const { task } = await add("Dropped", "2026-09-01", "2026-09-02");
    expect(await inA((q) => tasks.deleteTask(q, task!.id))).toBe(true);
    expect(await inA((q) => tasks.listTasks(q, JOB))).toEqual([]);

    const row = await inA((q) =>
      q.one<{ deleted_at: Date | null }>(`SELECT deleted_at FROM project_tasks WHERE id = $1`, [
        task!.id,
      ])
    );
    expect(row?.deleted_at).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Dependencies                                                        */
/* ------------------------------------------------------------------ */

describe("what a task waits for", () => {
  it("pushes a dependent task to the working day after its predecessor", async () => {
    const a = await add("Pedestal Drill", "2026-09-17", "2026-09-18"); // finishes Friday
    const b = await add("Lathe", "2026-09-01", "2026-09-02"); // wrongly earlier

    const { error, moved } = await inA((q) =>
      tasks.addDependency(q, JOB, b.task!.id, a.task!.id)
    );
    expect(error).toBeUndefined();
    expect(moved).toBe(1);

    const after = await inA((q) => tasks.findTask(q, b.task!.id));
    // Friday finish → Monday start, not Saturday.
    expect(after?.startsOn).toBe("2026-09-21");
    // And it keeps its own length: two working days.
    expect(after?.dueOn).toBe("2026-09-22");
  });

  it("carries the move down a chain", async () => {
    const a = await add("A", "2026-09-01", "2026-09-01");
    const b = await add("B", "2026-09-02", "2026-09-02");
    const c = await add("C", "2026-09-03", "2026-09-03");
    await inA((q) => tasks.addDependency(q, JOB, b.task!.id, a.task!.id));
    await inA((q) => tasks.addDependency(q, JOB, c.task!.id, b.task!.id));

    // Move the first task a week later; everything below follows.
    await inA((q) =>
      tasks.updateTask(q, a.task!.id, { name: "A", startsOn: "2026-09-08", dueOn: "2026-09-08" })
    );
    const movedCount = await inA((q) => tasks.cascade(q, JOB));
    expect(movedCount).toBe(2);

    const list = await inA((q) => tasks.listTasks(q, JOB));
    const byName = new Map(list.map((t) => [t.name, t]));
    expect(byName.get("B")?.startsOn).toBe("2026-09-09");
    expect(byName.get("C")?.startsOn).toBe("2026-09-10");
  });

  it("waits for the later of two predecessors", async () => {
    const early = await add("Early", "2026-09-01", "2026-09-02");
    const late = await add("Late", "2026-09-08", "2026-09-10");
    const both = await add("Needs both", "2026-09-01", "2026-09-01");

    await inA((q) => tasks.addDependency(q, JOB, both.task!.id, early.task!.id));
    await inA((q) => tasks.addDependency(q, JOB, both.task!.id, late.task!.id));

    const after = await inA((q) => tasks.findTask(q, both.task!.id));
    expect(after?.startsOn).toBe("2026-09-11");
  });

  it("honours a lag rather than closing the gap", async () => {
    const a = await add("Pour concrete", "2026-09-01", "2026-09-01");
    const b = await add("Build on it", "2026-09-02", "2026-09-02");
    await inA((q) => tasks.addDependency(q, JOB, b.task!.id, a.task!.id, 3));

    const after = await inA((q) => tasks.findTask(q, b.task!.id));
    // Tuesday finish + one day + three working days of curing.
    expect(after?.startsOn).toBe("2026-09-07");
  });

  it("refuses a loop rather than hanging on one", async () => {
    const a = await add("A", "2026-09-01", "2026-09-01");
    const b = await add("B", "2026-09-02", "2026-09-02");
    const c = await add("C", "2026-09-03", "2026-09-03");
    await inA((q) => tasks.addDependency(q, JOB, b.task!.id, a.task!.id));
    await inA((q) => tasks.addDependency(q, JOB, c.task!.id, b.task!.id));

    // A waiting for C would close the ring A → B → C → A.
    const { error } = await inA((q) => tasks.addDependency(q, JOB, a.task!.id, c.task!.id));
    expect(error).toMatch(/wait for each other/i);
  });

  it("refuses a task waiting for itself", async () => {
    const a = await add("A", "2026-09-01", "2026-09-01");
    const { error } = await inA((q) => tasks.addDependency(q, JOB, a.task!.id, a.task!.id));
    expect(error).toMatch(/cannot wait for itself/i);
  });

  it("refuses the same link twice", async () => {
    const a = await add("A", "2026-09-01", "2026-09-01");
    const b = await add("B", "2026-09-02", "2026-09-02");
    await inA((q) => tasks.addDependency(q, JOB, b.task!.id, a.task!.id));
    const { error } = await inA((q) => tasks.addDependency(q, JOB, b.task!.id, a.task!.id));
    expect(error).toMatch(/already waits/i);
  });

  it("leaves a plan that is already consistent alone", async () => {
    /* Idempotence. The cascade runs after every write, so a plan that drifted a
       day on each pass would be worse than no cascade at all. */
    const a = await add("A", "2026-09-01", "2026-09-01");
    const b = await add("B", "2026-09-02", "2026-09-02");
    await inA((q) => tasks.addDependency(q, JOB, b.task!.id, a.task!.id));

    expect(await inA((q) => tasks.cascade(q, JOB))).toBe(0);
    expect(await inA((q) => tasks.cascade(q, JOB))).toBe(0);
    const after = await inA((q) => tasks.findTask(q, b.task!.id));
    expect(after?.startsOn).toBe("2026-09-02");
  });

  it("does not move a task whose predecessor has no finish date", async () => {
    /* An unknown predecessor implies nothing, and a confident bar with nothing
       behind it is worse than an empty row. */
    const a = await add("Unscheduled", null, null);
    const b = await add("Waiting", "2026-09-02", "2026-09-03");
    await inA((q) => tasks.addDependency(q, JOB, b.task!.id, a.task!.id));

    const after = await inA((q) => tasks.findTask(q, b.task!.id));
    expect(after?.startsOn).toBe("2026-09-02");
  });

  it("cannot link across projects, even past the repository", async () => {
    const mine = await add("Mine", "2026-09-01", "2026-09-01");
    await db.seed(`INSERT INTO project_tasks (id, sub_account_id, deal_id, name)
                   VALUES ('pt_other', '${TENANT_B}', '${OTHER_JOB}', 'Theirs')`);
    await expect(
      db.seed(`INSERT INTO project_task_dependencies (id, sub_account_id, task_id, depends_on_id)
               VALUES ('dep_bad', '${TENANT_A}', '${mine.task!.id}', 'pt_other')`)
    ).rejects.toThrow();
  });

  it("forgets the link when it is removed", async () => {
    const a = await add("A", "2026-09-01", "2026-09-01");
    const b = await add("B", "2026-09-02", "2026-09-02");
    await inA((q) => tasks.addDependency(q, JOB, b.task!.id, a.task!.id));

    const links = await inA((q) => tasks.listDependencies(q, JOB));
    const link = links.get(b.task!.id)![0];
    expect(await inA((q) => tasks.removeDependency(q, link.id))).toBe(true);
    expect((await inA((q) => tasks.listDependencies(q, JOB))).size).toBe(0);
  });

  it("drops a link when the task it points at is deleted", async () => {
    /* A dangling predecessor would make the cascade read a task that is not
       there. The foreign key cascades, so the link goes with it. */
    const a = await add("A", "2026-09-01", "2026-09-01");
    const b = await add("B", "2026-09-02", "2026-09-02");
    await inA((q) => tasks.addDependency(q, JOB, b.task!.id, a.task!.id));

    await db.seed(`DELETE FROM project_tasks WHERE id = '${a.task!.id}'`);
    expect((await inA((q) => tasks.listDependencies(q, JOB))).size).toBe(0);
  });
});

describe("the workspace's own days off", () => {
  it("pushes a dependent task past a public holiday", async () => {
    /* Heritage Day 2026 is Thursday 24 September. A predecessor finishing on
       the Wednesday does not hand over until the Friday. */
    await db.seed(`INSERT INTO workspace_holidays (id, sub_account_id, on_date, name)
                   VALUES ('hol_heritage', '${TENANT_A}', DATE '2026-09-24', 'Heritage Day')`);

    const a = await add("Before", "2026-09-22", "2026-09-23");
    const b = await add("After", "2026-09-01", "2026-09-01");
    await inA((q) => tasks.addDependency(q, JOB, b.task!.id, a.task!.id));

    const after = await inA((q) => tasks.findTask(q, b.task!.id));
    expect(after?.startsOn).toBe("2026-09-25");
  });

  it("does not spend a holiday on a task's duration", async () => {
    /* A three-day task handed over on the Wednesday runs Wed, Fri, Mon —
       Thursday is closed, so the finish is the following Monday. */
    await db.seed(`INSERT INTO workspace_holidays (id, sub_account_id, on_date, name)
                   VALUES ('hol_heritage', '${TENANT_A}', DATE '2026-09-24', 'Heritage Day')`);

    const a = await add("Before", "2026-09-21", "2026-09-22");
    const b = await add("Three days", "2026-09-01", "2026-09-03"); // three working days
    await inA((q) => tasks.addDependency(q, JOB, b.task!.id, a.task!.id));

    const after = await inA((q) => tasks.findTask(q, b.task!.id));
    expect(after?.startsOn).toBe("2026-09-23");
    expect(after?.dueOn).toBe("2026-09-28");
  });

  it("is another workspace's business, not this one's", async () => {
    /* The holidays are tenant data like everything else: a client of this
       agency closing for a day must not move another client's schedule. */
    await db.seed(`INSERT INTO workspace_holidays (id, sub_account_id, on_date, name)
                   VALUES ('hol_theirs', '${TENANT_B}', DATE '2026-09-24', 'Not ours')`);

    const a = await add("Before", "2026-09-22", "2026-09-23");
    const b = await add("After", "2026-09-01", "2026-09-01");
    await inA((q) => tasks.addDependency(q, JOB, b.task!.id, a.task!.id));

    const after = await inA((q) => tasks.findTask(q, b.task!.id));
    // Thursday is a working day here, because THIS workspace declared nothing.
    expect(after?.startsOn).toBe("2026-09-24");
  });
});

describe("a task has one length, not two", () => {
  it("counts duration in WORKING days, the same unit the scheduler moves in", async () => {
    /*
       Friday to Monday is two days of work, not four days of calendar. It read
       "4 days" in the task list while the cascade preserved it as two — so the
       same task had two lengths, and moving it to a Monday-Tuesday slot would
       have displayed "2 days" as though it had shrunk.
    */
    const { task } = await add("Friday to Monday", "2026-09-18", "2026-09-21");
    expect(task?.durationDays).toBe(2);
  });

  it("does not spend a public holiday on a task's length either", async () => {
    await db.seed(`INSERT INTO workspace_holidays (id, sub_account_id, on_date, name)
                   VALUES ('hol_h', '${TENANT_A}', DATE '2026-09-24', 'Heritage Day')`);
    // Mon 21 to Fri 25 September: five weekdays, one of them closed.
    const { task } = await add("Across Heritage Day", "2026-09-21", "2026-09-25");
    expect(task?.durationDays).toBe(4);
  });

  it("weights the rollup by working days, so a weekend does not inflate a task", async () => {
    /* The rollup multiplies by this number, so a calendar count gave a
       weekend-spanning task twice the weight it had earned. */
    await add("Fri to Mon, untouched", "2026-09-18", "2026-09-21", 0); // 2 days
    await add("Tue to Wed, done", "2026-09-22", "2026-09-23", 100); // 2 days
    const list = await inA((q) => tasks.listTasks(q, JOB));
    // Two equal tasks, one finished: half. With calendar days it would be 4:2
    // and report 33%.
    expect(tasks.summarise(list, "2026-09-30").percentComplete).toBe(50);
  });
});
