import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  daysForLine,
  isDayUnit,
  MAX_INFERRED_DAYS,
  planFromLines,
  unitLookup,
} from "../src/server/plan-from-quote";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The schedule a quotation already implies.
 *
 * Adding a task takes five fields and a real job has fifteen of them, so the
 * Timeline was asking somebody to retype work that had already been itemised,
 * priced, approved and accepted. This builds it instead.
 *
 * Two halves, tested for different reasons. The LAYOUT is arithmetic over
 * working days and holidays, checked against dates worked out by hand. The
 * CHOICE OF QUOTATION is a safety rule: a plan may only come from a document a
 * person signed off, because building one from an unapproved draft would turn
 * an agent's guess into the shape of the job.
 */

/* ---------- the layout ---------- */

/** Nothing closed, so weekends alone move a date. */
const noHolidays = undefined;

/** A price list that knows two of the three lines. */
const unitFor = unitLookup([
  { name: "Mobile crane hire", unit: "per day" },
  { name: "Site survey", unit: "each" },
]);

describe("how long a line runs for", () => {
  it("reads a length from a day-based unit", () => {
    expect(daysForLine(3, "per day")).toEqual({ workingDays: 3, durationKnown: true });
    expect(daysForLine(1, "day")).toEqual({ workingDays: 1, durationKnown: true });
  });

  it("ADMITS it is guessing for anything else", () => {
    /* A quantity is not a duration: "Cable, 2500" is metres, and "Site survey,
       2" is two surveys. Claiming to know is worse than a placeholder. */
    expect(daysForLine(2500, "m")).toEqual({ workingDays: 1, durationKnown: false });
    expect(daysForLine(2, "each")).toEqual({ workingDays: 1, durationKnown: false });
    expect(daysForLine(3, null)).toEqual({ workingDays: 1, durationKnown: false });
  });

  it("rounds a part-day up", () => {
    // Half a day of work still occupies a day on a chart somebody plans around.
    expect(daysForLine(0.5, "per day").workingDays).toBe(1);
    expect(daysForLine(2.1, "per day").workingDays).toBe(3);
  });

  it("caps a length that is obviously not days", () => {
    /* Without this, one mis-typed line draws a bar years long and every other
       task on the chart becomes a sliver. */
    expect(daysForLine(9999, "per day").workingDays).toBe(MAX_INFERRED_DAYS);
  });

  it("never produces a zero-length task", () => {
    for (const q of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(daysForLine(q, "per day").workingDays).toBeGreaterThanOrEqual(1);
    }
  });

  it("recognises the ways a unit says day", () => {
    for (const unit of ["day", "days", "per day", "Per Day", "  per  day  "]) {
      expect(isDayUnit(unit), unit).toBe(true);
    }
    for (const unit of ["each", "m", "hour", "per month", "", null, undefined]) {
      expect(isDayUnit(unit), String(unit)).toBe(false);
    }
  });
});

describe("laying the lines out", () => {
  it("chains them end to end, skipping the weekend", () => {
    /*
       Worked out by hand. Friday 2 October 2026 is a Friday.
         crane, 3 days  → Fri 2, Mon 5, Tue 6      finishes Tue 6 Oct
         survey, 1 day  → starts Wed 7             finishes Wed 7 Oct
    */
    const plan = planFromLines(
      [
        { description: "Mobile crane hire", quantity: 3 },
        { description: "Site survey", quantity: 1 },
      ],
      { startsOn: "2026-10-02", unitFor, holidays: noHolidays }
    );

    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ startsOn: "2026-10-02", dueOn: "2026-10-06", workingDays: 3 });
    expect(plan[1]).toMatchObject({ startsOn: "2026-10-07", dueOn: "2026-10-07" });
  });

  it("starts on a working day even when asked to start on a Saturday", () => {
    // 3 October 2026 is a Saturday; the plan should open on the Monday.
    const plan = planFromLines([{ description: "Site survey", quantity: 1 }], {
      startsOn: "2026-10-03",
      unitFor,
      holidays: noHolidays,
    });
    expect(plan[0].startsOn).toBe("2026-10-05");
  });

  it("steps over a closed day", () => {
    /* The workspace's own holidays, which the scheduler already honours
       everywhere else — a plan that lands work on a day the business is shut
       is one somebody has to redo by hand. */
    const closed = new Set(["2026-10-05"]);
    const plan = planFromLines([{ description: "Site survey", quantity: 1 }], {
      startsOn: "2026-10-03",
      unitFor,
      holidays: closed,
    });
    expect(plan[0].startsOn, "Monday is closed, so it opens on the Tuesday").toBe("2026-10-06");
  });

  it("keeps the order the quotation was written in", () => {
    /* The sequence is the one piece of scheduling information a quotation
       really carries. Sorting it would throw away the only ordering anybody
       actually decided. */
    const plan = planFromLines(
      [
        { description: "Zebra crossing" },
        { description: "Alpha works" },
        { description: "Middle bit" },
      ].map((l) => ({ ...l, quantity: 1 })),
      { startsOn: "2026-10-05", unitFor, holidays: noHolidays }
    );
    expect(plan.map((p) => p.name)).toEqual(["Zebra crossing", "Alpha works", "Middle bit"]);
  });

  it("drops a line with no description rather than making a nameless task", () => {
    /* Subtotals and spacers. A task nobody can read is worse than one fewer. */
    const plan = planFromLines(
      [
        { description: "  ", quantity: 1 },
        { description: "Site survey", quantity: 1 },
      ],
      { startsOn: "2026-10-05", unitFor, holidays: noHolidays }
    );
    expect(plan.map((p) => p.name)).toEqual(["Site survey"]);
  });

  it("matches the price list however the line was capitalised", () => {
    const plan = planFromLines([{ description: "  mobile   CRANE hire ", quantity: 2 }], {
      startsOn: "2026-10-05",
      unitFor,
      holidays: noHolidays,
    });
    expect(plan[0].workingDays, "the unit was not recovered").toBe(2);
    expect(plan[0].durationKnown).toBe(true);
  });

  it("marks the lengths it had to assume", () => {
    const plan = planFromLines(
      [
        { description: "Mobile crane hire", quantity: 3 },
        { description: "Something not on the price list", quantity: 4 },
      ],
      { startsOn: "2026-10-05", unitFor, holidays: noHolidays }
    );
    expect(plan.map((p) => p.durationKnown)).toEqual([true, false]);
  });

  it("never overlaps two tasks", () => {
    /* A quotation says what the work is, never what can run at once. Claiming
       parallelism it does not know about is a worse starting point than a
       queue somebody drags apart. */
    const plan = planFromLines(
      Array.from({ length: 6 }, (_, i) => ({ description: `Task ${i}`, quantity: 2 })),
      { startsOn: "2026-10-05", unitFor: () => "per day", holidays: noHolidays }
    );
    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].startsOn > plan[i - 1].dueOn, `task ${i} starts before ${i - 1} ends`).toBe(true);
    }
  });
});

/* ---------- which quotation, and what it writes ---------- */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let plan: typeof import("../src/server/plan-from-quote");
let tasks: typeof import("../src/server/repos/tasks");
let closePool: typeof import("../src/server/db").closePool;

const CTX: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(CTX, fn);
const JOB = "d_plan";

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  plan = await import("../src/server/plan-from-quote");
  tasks = await import("../src/server/repos/tasks");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM project_task_dependencies; DELETE FROM project_tasks;
    DELETE FROM document_lines; DELETE FROM documents;
    DELETE FROM price_items; DELETE FROM deals; DELETE FROM contacts;

    INSERT INTO deals (id, sub_account_id, title, value_cents, stage, starts_on)
    VALUES ('${JOB}', '${TENANT_A}', 'Rebuild warehouse', 100000, 'won', '2126-10-02');

    INSERT INTO price_items (id, sub_account_id, name, unit, unit_cents) VALUES
      ('pi_crane', '${TENANT_A}', 'Mobile crane hire', 'per day', 1200000),
      ('pi_survey', '${TENANT_A}', 'Site survey', 'each', 125050);`)
);

/** A quotation in whatever state the test needs. */
const quote = (status: string, lines: [string, number][] = [["Mobile crane hire", 3], ["Site survey", 1]]) =>
  db.seed(`
    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status)
    VALUES ('doc_${status}', '${TENANT_A}', '${JOB}', 'quote', 'Q-${status}', '${status}');
    ${lines
      .map(
        ([d, qty], i) =>
          `INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position)
           VALUES ('dl_${status}_${i}', '${TENANT_A}', 'doc_${status}', '${d}', ${qty}, 0, ${i});`
      )
      .join("\n")}`);

describe("which quotation a plan may be built from", () => {
  it("builds from one the client accepted", async () => {
    await quote("accepted");
    const result = await inA((q) => plan.buildPlanFromQuote(q, JOB));
    expect(result.error).toBeUndefined();
    expect(result.created).toBe(2);
    expect(result.quoteNumber).toBe("Q-accepted");
  });

  it("REFUSES a draft nobody has approved", async () => {
    /*
       The safety rule this shares with the rest of the product: the AI drafts,
       a named human approves, and only then does anything count. A plan built
       from an unapproved draft would make an agent's guess into the shape of
       the job — and it would look exactly as authoritative as a real one.
    */
    await quote("draft");
    const result = await inA((q) => plan.buildPlanFromQuote(q, JOB));
    expect(result.created).toBeUndefined();
    expect(result.error).toMatch(/no approved quotation/i);
    expect(await inA((q) => tasks.listTasks(q, JOB))).toHaveLength(0);
  });

  it("refuses one still awaiting approval", async () => {
    await quote("awaiting_approval");
    const result = await inA((q) => plan.buildPlanFromQuote(q, JOB));
    expect(result.error).toMatch(/no approved quotation/i);
  });

  it("prefers what the client accepted over what was merely sent", async () => {
    await quote("sent");
    await quote("accepted");
    const result = await inA((q) => plan.buildPlanFromQuote(q, JOB));
    expect(result.quoteNumber).toBe("Q-accepted");
  });

  it("refuses to build over a plan somebody is already keeping", async () => {
    /* Merging a quotation into a maintained schedule is a different and much
       harder feature. Appending fifteen duplicates silently is worse than
       doing nothing. */
    await quote("accepted");
    await inA((q) => tasks.addTask(q, JOB, { name: "Already here", percentComplete: 0 }));

    const result = await inA((q) => plan.buildPlanFromQuote(q, JOB));
    expect(result.error).toMatch(/already has a schedule/i);
    expect(await inA((q) => tasks.listTasks(q, JOB))).toHaveLength(1);
  });
});

describe("what the plan looks like once written", () => {
  it("keeps the quotation's order and chains each task to the last", async () => {
    await quote("accepted");
    await inA((q) => plan.buildPlanFromQuote(q, JOB));

    const written = await inA((q) => tasks.listTasks(q, JOB));
    expect(written.map((t) => t.name)).toEqual(["Mobile crane hire", "Site survey"]);

    /* The dependency is what makes the plan hold together afterwards: moving
       the first task carries the rest with it rather than leaving fixed dates
       that quietly stop meaning anything. */
    const links = await inA((q) => tasks.listDependencies(q, JOB));
    expect(links.size, "exactly one task should be waiting on another").toBe(1);
    expect(
      links.get(written[1].id)?.map((l) => l.dependsOnId),
      "the second task does not wait for the first"
    ).toEqual([written[0].id]);
    expect(links.get(written[0].id), "the first task waits for nothing").toBeUndefined();
  });

  it("reports how many lengths it had to assume", async () => {
    /* Named rather than buried: the shape is trustworthy, the lengths are a
       starting point, and only one of those is worth acting on unchecked. */
    await quote("accepted");
    const result = await inA((q) => plan.buildPlanFromQuote(q, JOB));
    expect(result.assumed, "the survey is priced per item, not per day").toBe(1);
  });

  it("starts from the project's own start date when it has one", async () => {
    await quote("accepted");
    await inA((q) => plan.buildPlanFromQuote(q, JOB));
    const written = await inA((q) => tasks.listTasks(q, JOB));
    // The fixture's project starts on a Friday far in the future.
    expect(written[0].startsOn).toBe("2126-10-02");
  });

  it("does not start a plan in the past", async () => {
    /* A schedule that opens before today is one somebody has to drag before
       they can read it. */
    await db.seed(`UPDATE deals SET starts_on = '2020-01-01' WHERE id = '${JOB}'`);
    await quote("accepted");
    await inA((q) => plan.buildPlanFromQuote(q, JOB));

    const written = await inA((q) => tasks.listTasks(q, JOB));
    expect(written[0].startsOn! >= new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it("says so when the quotation has nothing on it", async () => {
    await quote("accepted", []);
    const result = await inA((q) => plan.buildPlanFromQuote(q, JOB));
    expect(result.error).toMatch(/no lines/i);
  });
});
