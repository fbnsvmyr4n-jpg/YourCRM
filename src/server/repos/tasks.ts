import { earliestStart, finishAfter, workingDaysBetween } from "../schedule";
import { holidaySet } from "./holidays";
import type { TenantQuery } from "../tenant";

/**
 * The work a project is made of.
 *
 * The project screen could say what a job was worth, who was on it and what had
 * been said about it, and could not say what the WORK was. This is the missing
 * half: a task list with dates and a percentage against each row, which is the
 * shape every real schedule takes — Bradley's own 2026 Procedures baseline is
 * exactly that, nineteen rows with a start, a finish and a % complete.
 *
 * Two rules run through everything below.
 *
 * **Duration is derived, never stored.** It is the span between the dates, and
 * a stored copy would be a second answer to a question the dates already
 * answer — stale the moment somebody moves one. Same rule the documents table
 * follows for totals.
 *
 * **A percentage and a completion date must agree.** `done_at` is set and
 * cleared here, alongside the percentage, rather than left to each caller — so
 * there is no way to write a task that is 100% and never finished, or finished
 * and 60%.
 */

export type ProjectTask = {
  id: string;
  name: string;
  /** `YYYY-MM-DD`, or null while the date is still unknown. */
  startsOn: string | null;
  dueOn: string | null;
  percentComplete: number;
  /** When it reached 100. Null while there is still work in it. */
  doneAt: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  position: number;
  /**
   * WORKING days from start to finish inclusive, so a task that starts and
   * finishes on the same day is one day rather than zero.
   *
   * Working, not calendar, and that distinction is the whole point: the
   * scheduler moves tasks by working days, so a calendar count made the same
   * task two lengths at once. A job running Friday to Monday showed "4 days"
   * in the list while the cascade preserved it as two days of work — and
   * moving it to a Monday-to-Tuesday slot would then have displayed "2 days",
   * as though the task had shrunk. It also skews the rollup, which weights by
   * this number: a weekend-spanning task counted double what it was worth.
   */
  durationDays: number | null;
};

type Row = {
  id: string;
  name: string;
  starts_on: string | null;
  due_on: string | null;
  percent_complete: number;
  done_at: Date | null;
  owner_user_id: string | null;
  owner_name: string | null;
  position: number;
};

/* Dates are cast to text in SQL and never parsed into a Date. A DATE is a
   calendar day; read as a timestamp and formatted in a zone behind UTC, a
   1 September start renders as 31 August — the bug this project has already
   had once, on the project header's own dates. */
function durationOf(
  startsOn: string | null,
  dueOn: string | null,
  closed: ReadonlySet<string> | undefined
): number | null {
  if (!startsOn || !dueOn) return null;
  return workingDaysBetween(startsOn, dueOn, closed);
}

const toTask = (r: Row, closed?: ReadonlySet<string>): ProjectTask => ({
  id: r.id,
  name: r.name,
  startsOn: r.starts_on,
  dueOn: r.due_on,
  percentComplete: r.percent_complete,
  doneAt: r.done_at?.toISOString() ?? null,
  ownerUserId: r.owner_user_id,
  ownerName: r.owner_name,
  position: r.position,
  durationDays: durationOf(r.starts_on, r.due_on, closed),
});

function newId(): string {
  return `pt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* Named TASK_SELECT, not SELECT. The guard suite finds SQL by scanning for
   backticked literals containing a SQL keyword, and a constant called `SELECT`
   makes `const SELECT = ` itself look like the start of one — which silently
   excluded this query from the check that every statement filters the tenant.
   The underscore breaks the word boundary, the way `DOC_SELECT` already does. */
const TASK_SELECT = `
  SELECT t.id, t.name, t.starts_on::text, t.due_on::text, t.percent_complete,
         t.done_at, t.owner_user_id, u.name AS owner_name, t.position
    FROM project_tasks t
    LEFT JOIN users u ON u.id = t.owner_user_id
   WHERE t.sub_account_id = $1 AND t.deleted_at IS NULL
`;

/**
 * The schedule, in the order it reads.
 *
 * By `position` then `starts_on`: the order somebody arranged it in wins, and
 * dates only break a tie. Sorting by date alone would silently reorder a plan
 * every time a date moved, which is the one thing a schedule must not do.
 */
export async function listTasks(q: TenantQuery, dealId: string): Promise<ProjectTask[]> {
  const rows = await q.rows<Row>(
    `${TASK_SELECT} AND t.deal_id = $2
      ORDER BY t.position, t.starts_on NULLS LAST, t.created_at`,
    [q.ctx.subAccountId, dealId]
  );
  /* Read once for the whole list. Durations are counted in working days, so
     the closed days are part of the answer, not a detail of the cascade. */
  const closed = await holidaySet(q);
  return rows.map((r) => toTask(r, closed));
}

export type TaskInput = {
  name: string;
  startsOn?: string | null;
  dueOn?: string | null;
  percentComplete?: number;
  ownerUserId?: string | null;
};

export type TaskResult = { task?: ProjectTask; error?: string };

/** Clamped, and whole. A percentage is the one field a form can most easily
    make nonsense of, and the CHECK constraint refuses rather than corrects. */
function clampPercent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export async function addTask(
  q: TenantQuery,
  dealId: string,
  input: TaskInput
): Promise<TaskResult> {
  const name = input.name.trim();
  if (!name) return { error: "Give the task a name." };

  if (input.startsOn && input.dueOn && input.dueOn < input.startsOn) {
    return { error: "That task finishes before it starts." };
  }

  const deal = await q.one<{ id: string }>(
    `SELECT id FROM deals WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL`,
    [q.ctx.subAccountId, dealId]
  );
  if (!deal) return { error: "That project no longer exists." };

  /* Appended to the end of the plan. `COALESCE` because the first task on a
     project has no maximum to follow. */
  const next = await q.one<{ position: number }>(
    `SELECT COALESCE(MAX(position) + 1, 0) AS position
       FROM project_tasks
      WHERE sub_account_id = $1 AND deal_id = $2 AND deleted_at IS NULL`,
    [q.ctx.subAccountId, dealId]
  );

  const percent = clampPercent(input.percentComplete);
  const id = newId();

  await q.rows(
    `INSERT INTO project_tasks
       (id, sub_account_id, deal_id, name, starts_on, due_on, percent_complete,
        done_at, owner_user_id, position)
     VALUES ($1, $2, $3, $4, $5::date, $6::date, $7,
             CASE WHEN $7 = 100 THEN now() ELSE NULL END, $8, $9)`,
    [
      id,
      q.ctx.subAccountId,
      dealId,
      name,
      input.startsOn ?? null,
      input.dueOn ?? null,
      percent,
      input.ownerUserId ?? null,
      next?.position ?? 0,
    ]
  );

  const task = await findTask(q, id);
  return task ? { task } : { error: "The task could not be saved." };
}

export async function findTask(q: TenantQuery, taskId: string): Promise<ProjectTask | null> {
  const rows = await q.rows<Row>(`${TASK_SELECT} AND t.id = $2`, [q.ctx.subAccountId, taskId]);
  if (!rows[0]) return null;
  return toTask(rows[0], await holidaySet(q));
}

/**
 * Edit a task.
 *
 * `done_at` moves with the percentage and is never passed in: reaching 100
 * stamps it, dropping below 100 clears it. A caller cannot get the pair out of
 * step because a caller does not touch it.
 *
 * Reaching 100 twice keeps the FIRST completion date — `COALESCE` — so saving
 * an already-finished task to fix a typo does not quietly move the day the work
 * was done.
 */
export async function updateTask(
  q: TenantQuery,
  taskId: string,
  input: TaskInput
): Promise<TaskResult> {
  const name = input.name.trim();
  if (!name) return { error: "Give the task a name." };
  if (input.startsOn && input.dueOn && input.dueOn < input.startsOn) {
    return { error: "That task finishes before it starts." };
  }

  const percent = clampPercent(input.percentComplete);

  const row = await q.one<{ id: string }>(
    `UPDATE project_tasks
        SET name = $3, starts_on = $4::date, due_on = $5::date,
            percent_complete = $6,
            done_at = CASE WHEN $6 = 100 THEN COALESCE(done_at, now()) ELSE NULL END,
            owner_user_id = $7, updated_at = now()
      WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [
      q.ctx.subAccountId,
      taskId,
      name,
      input.startsOn ?? null,
      input.dueOn ?? null,
      percent,
      input.ownerUserId ?? null,
    ]
  );
  if (!row) return { error: "That task no longer exists." };

  const task = await findTask(q, taskId);
  return task ? { task } : { error: "That task no longer exists." };
}

/**
 * Tick a task off, or reopen it.
 *
 * Its own function rather than a general edit, because this is the change that
 * actually gets made day to day and it should be one press from the schedule.
 */
export async function setTaskComplete(
  q: TenantQuery,
  taskId: string,
  done: boolean
): Promise<TaskResult> {
  const row = await q.one<{ id: string }>(
    `UPDATE project_tasks
        SET percent_complete = CASE WHEN $3 THEN 100 ELSE 0 END,
            done_at = CASE WHEN $3 THEN COALESCE(done_at, now()) ELSE NULL END,
            updated_at = now()
      WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [q.ctx.subAccountId, taskId, done]
  );
  if (!row) return { error: "That task no longer exists." };
  const task = await findTask(q, taskId);
  return task ? { task } : { error: "That task no longer exists." };
}

/** A soft delete: a task that was planned and dropped is a fact about the job. */
export async function deleteTask(q: TenantQuery, taskId: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE project_tasks SET deleted_at = now(), updated_at = now()
      WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [q.ctx.subAccountId, taskId]
  );
  return row !== null;
}

/** Move a task up or down the plan, swapping with its neighbour. */
export async function moveTask(
  q: TenantQuery,
  dealId: string,
  taskId: string,
  direction: "up" | "down"
): Promise<boolean> {
  const tasks = await listTasks(q, dealId);
  const index = tasks.findIndex((t) => t.id === taskId);
  if (index === -1) return false;
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= tasks.length) return false;

  /* Rewritten by index rather than by swapping the two stored values. Positions
     can legitimately be equal — every task added before this feature had 0 — and
     swapping two identical numbers moves nothing at all. */
  const reordered = [...tasks];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];

  for (const [position, task] of reordered.entries()) {
    await q.rows(
      `UPDATE project_tasks SET position = $3, updated_at = now()
        WHERE id = $2 AND sub_account_id = $1`,
      [q.ctx.subAccountId, task.id, position]
    );
  }
  return true;
}

export type ScheduleSummary = {
  tasks: number;
  done: number;
  /** 0-100, weighted by duration. Null when nothing is scheduled. */
  percentComplete: number | null;
  /** The span the whole plan covers, for drawing an axis. */
  startsOn: string | null;
  dueOn: string | null;
  /** Unfinished tasks whose finish date has passed. */
  overdue: number;
};

/**
 * How far along the project is.
 *
 * **Weighted by duration**, which is the only honest way to add tasks up. A
 * plain average of percentages says a job is half done when the ten-day task
 * has not started and the half-day one is finished — the arithmetic is right
 * and the answer is a lie. A task with no dates counts as one day, so it still
 * carries weight rather than silently disappearing from the total.
 *
 * Computed here rather than stored, for the reason every derived figure in this
 * codebase is: a stored total goes stale the moment a task moves, and then two
 * screens disagree about the same project.
 */
export function summarise(tasks: ProjectTask[], today: string): ScheduleSummary {
  if (tasks.length === 0) {
    return { tasks: 0, done: 0, percentComplete: null, startsOn: null, dueOn: null, overdue: 0 };
  }

  let weighted = 0;
  let weight = 0;
  for (const task of tasks) {
    const days = task.durationDays ?? 1;
    weight += days;
    weighted += days * task.percentComplete;
  }

  const starts = tasks.map((t) => t.startsOn).filter((d): d is string => d !== null);
  const dues = tasks.map((t) => t.dueOn).filter((d): d is string => d !== null);

  return {
    tasks: tasks.length,
    done: tasks.filter((t) => t.percentComplete === 100).length,
    percentComplete: weight === 0 ? 0 : Math.round(weighted / weight),
    /* String comparison is correct on `YYYY-MM-DD` and cannot drift a day the
       way parsing into a Date can. */
    startsOn: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null,
    dueOn: dues.length ? dues.reduce((a, b) => (a > b ? a : b)) : null,
    overdue: tasks.filter((t) => t.percentComplete < 100 && t.dueOn !== null && t.dueOn < today)
      .length,
  };
}

/* ------------------------------------------------------------------ */
/* What a task waits for                                               */
/* ------------------------------------------------------------------ */

export type Dependency = { id: string; dependsOnId: string; lagDays: number };

/** Every link on a project, keyed by the task that waits. */
export async function listDependencies(
  q: TenantQuery,
  dealId: string
): Promise<Map<string, Dependency[]>> {
  const rows = await q.rows<{ id: string; task_id: string; depends_on_id: string; lag_days: number }>(
    `SELECT d.id, d.task_id, d.depends_on_id, d.lag_days
       FROM project_task_dependencies d
       JOIN project_tasks t ON t.id = d.task_id AND t.deleted_at IS NULL
      WHERE d.sub_account_id = $1 AND t.deal_id = $2
      ORDER BY d.created_at`,
    [q.ctx.subAccountId, dealId]
  );

  const byTask = new Map<string, Dependency[]>();
  for (const r of rows) {
    const link: Dependency = { id: r.id, dependsOnId: r.depends_on_id, lagDays: r.lag_days };
    const bucket = byTask.get(r.task_id);
    if (bucket) bucket.push(link);
    else byTask.set(r.task_id, [link]);
  }
  return byTask;
}

export type LinkResult = { error?: string; moved?: number };

/**
 * Make one task wait for another, then let the dates fall out of it.
 *
 * The cycle check is the load-bearing part. A → B → A is not merely invalid
 * data: the cascade below walks the graph, so a loop is an infinite one, and
 * the first person to draw a circle would hang their own request. It is checked
 * with a recursive query against the database rather than against a list held
 * in memory, so a link added by anything — this function, a script, a future
 * importer — is checked against what is actually stored.
 */
export async function addDependency(
  q: TenantQuery,
  dealId: string,
  taskId: string,
  dependsOnId: string,
  lagDays = 0
): Promise<LinkResult> {
  if (taskId === dependsOnId) return { error: "A task cannot wait for itself." };

  /*
     Would this close a loop? It does if the task being waited FOR already
     depends, at any depth, on the task that would be waiting.

     `UNION` rather than `UNION ALL`: on a graph that already contained a cycle
     the ALL form would never terminate, and the query written to detect loops
     must not be the thing that hangs on one.
  */
  const loop = await q.one<{ id: string }>(
    `WITH RECURSIVE upstream(id) AS (
       SELECT depends_on_id FROM project_task_dependencies
        WHERE sub_account_id = $1 AND task_id = $2
       UNION
       SELECT d.depends_on_id FROM project_task_dependencies d
         JOIN upstream u ON u.id = d.task_id
        WHERE d.sub_account_id = $1
     )
     SELECT id FROM upstream WHERE id = $3 LIMIT 1`,
    [q.ctx.subAccountId, dependsOnId, taskId]
  );
  if (loop) {
    return { error: "That would make the two tasks wait for each other." };
  }

  try {
    /* Inside a savepoint, because the whole point of the catch below is to
       keep going afterwards — and a constraint violation invalidates the
       entire transaction, not just the statement that caused it. Without one,
       "that task already waits for this one" was reported while every later
       statement on the same connection answered "current transaction is
       aborted", including `cascade` and whatever the caller read next. */
    await q.attempt(() =>
      q.rows(
        `INSERT INTO project_task_dependencies (id, sub_account_id, task_id, depends_on_id, lag_days)
         VALUES ($1, $2, $3, $4, $5)`,
        [`dep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
         q.ctx.subAccountId, taskId, dependsOnId, Math.max(0, Math.round(lagDays))]
      )
    );
  } catch (err) {
    const message = String(err);
    if (message.includes("project_task_deps_once")) {
      return { error: "That task already waits for this one." };
    }
    if (message.includes("same project")) {
      return { error: "A task can only wait for another task on the same project." };
    }
    throw err;
  }

  return { moved: await cascade(q, dealId) };
}

export async function removeDependency(q: TenantQuery, linkId: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `DELETE FROM project_task_dependencies
      WHERE id = $2 AND sub_account_id = $1 RETURNING id`,
    [q.ctx.subAccountId, linkId]
  );
  return row !== null;
}

/**
 * Push every dependent task to where its predecessors leave it.
 *
 * This is what "the staircase maintains itself" means: move one date and
 * everything below it follows, keeping each task's own length. Run after any
 * change that could invalidate a date — a link added, a task's finish moved.
 *
 * Two rules make it safe to run at any time.
 *
 * It is **idempotent**: a plan already consistent moves nothing, so this can be
 * called after every write without dates drifting a day each time.
 *
 * It moves a task **only when it has somewhere to be** — an undated predecessor
 * implies nothing, and a task nobody waits behind is left exactly where the
 * person who typed it put it. The cascade tidies consequences; it does not
 * take over the plan.
 *
 * Returns how many tasks actually moved, so the screen can say so rather than
 * silently rewriting dates somebody chose.
 */
export async function cascade(q: TenantQuery, dealId: string): Promise<number> {
  const tasks = await listTasks(q, dealId);
  const links = await listDependencies(q, dealId);
  if (links.size === 0) return 0;

  /* Read once for the whole cascade rather than per task: it is the same set
     for every date being computed, and a query inside the loop would be one
     round trip per row of the plan. */
  const closed = await holidaySet(q);

  const byId = new Map(tasks.map((t) => [t.id, { ...t }]));

  /*
     Topological order, so a task is placed only after everything it waits for.
     Kahn's algorithm; anything left over sat in a cycle, which the insert path
     refuses — but a graph written before that check existed, or by hand, would
     otherwise loop here forever. Leftovers are skipped rather than trusted.
  */
  const waitingOn = new Map<string, number>();
  const feeds = new Map<string, string[]>();
  for (const task of tasks) waitingOn.set(task.id, 0);
  for (const [taskId, deps] of links) {
    if (!waitingOn.has(taskId)) continue;
    for (const dep of deps) {
      if (!waitingOn.has(dep.dependsOnId)) continue;
      waitingOn.set(taskId, (waitingOn.get(taskId) ?? 0) + 1);
      const list = feeds.get(dep.dependsOnId);
      if (list) list.push(taskId);
      else feeds.set(dep.dependsOnId, [taskId]);
    }
  }

  const queue = tasks.filter((t) => (waitingOn.get(t.id) ?? 0) === 0).map((t) => t.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of feeds.get(id) ?? []) {
      const remaining = (waitingOn.get(next) ?? 0) - 1;
      waitingOn.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  let moved = 0;
  for (const id of order) {
    const deps = links.get(id);
    if (!deps || deps.length === 0) continue;
    const task = byId.get(id);
    if (!task) continue;

    const start = earliestStart(
      deps.map((d) => ({ dueOn: byId.get(d.dependsOnId)?.dueOn ?? null, lagDays: d.lagDays })),
      closed
    );
    if (!start || start === task.startsOn) continue;

    /* The task keeps its own length. Without a finish date there is no length
       to keep, so it takes a single day rather than inventing a span. */
    const days =
      task.startsOn && task.dueOn ? workingDaysBetween(task.startsOn, task.dueOn, closed) : 1;
    const due = finishAfter(start, days, closed);

    await q.rows(
      `UPDATE project_tasks SET starts_on = $3::date, due_on = $4::date, updated_at = now()
        WHERE id = $2 AND sub_account_id = $1`,
      [q.ctx.subAccountId, id, start, due]
    );
    task.startsOn = start;
    task.dueOn = due;
    moved += 1;
  }

  return moved;
}
