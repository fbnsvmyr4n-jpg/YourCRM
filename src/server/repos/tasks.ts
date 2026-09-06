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
   * Whole days from start to finish INCLUSIVE, so a task that starts and
   * finishes on the same day is one day rather than zero — which is what a
   * person means by a one-day job, and what every schedule shows.
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
const MS_PER_DAY = 86_400_000;

function durationOf(startsOn: string | null, dueOn: string | null): number | null {
  if (!startsOn || !dueOn) return null;
  /* Both are `YYYY-MM-DD`, so parsing them as UTC midnight is exact — no zone
     is involved on either side and the difference is a whole number of days. */
  const start = Date.parse(`${startsOn}T00:00:00Z`);
  const due = Date.parse(`${dueOn}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(due)) return null;
  return Math.round((due - start) / MS_PER_DAY) + 1;
}

const toTask = (r: Row): ProjectTask => ({
  id: r.id,
  name: r.name,
  startsOn: r.starts_on,
  dueOn: r.due_on,
  percentComplete: r.percent_complete,
  doneAt: r.done_at?.toISOString() ?? null,
  ownerUserId: r.owner_user_id,
  ownerName: r.owner_name,
  position: r.position,
  durationDays: durationOf(r.starts_on, r.due_on),
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
  return rows.map(toTask);
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
  return rows[0] ? toTask(rows[0]) : null;
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
