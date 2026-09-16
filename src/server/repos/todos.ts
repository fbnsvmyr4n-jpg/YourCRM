import type { TenantQuery } from "../tenant";
import type { Todo } from "../todo-rules";

/**
 * Tasks, as rows.
 *
 * Tenant-scoped like every CRM table: each statement filters `sub_account_id`
 * itself, row-level security enforces the same underneath, and a trigger
 * refuses an assignee, contact or deal from another workspace.
 */

type Row = {
  id: string;
  title: string;
  notes: string | null;
  due_on: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  deal_id: string | null;
  deal_title: string | null;
  done_at: Date | null;
  created_by_user_id: string | null;
  automation_id: string | null;
  created_at: Date;
};

/* The names are read in the same statement, and only from live records: a
   task for a contact who was since deleted shows no name rather than a ghost. */
const SELECT = `
  SELECT t.id, t.title, t.notes, t.due_on::text AS due_on,
         t.assignee_user_id, u.name AS assignee_name,
         t.contact_id, NULLIF(btrim(c.first_name || ' ' || c.last_name), '') AS contact_name,
         t.deal_id, d.title AS deal_title,
         t.done_at, t.created_by_user_id, t.automation_id, t.created_at
    FROM todos t
    LEFT JOIN users u    ON u.id = t.assignee_user_id AND u.deleted_at IS NULL
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.sub_account_id = t.sub_account_id AND c.deleted_at IS NULL
    LEFT JOIN deals d    ON d.id = t.deal_id AND d.sub_account_id = t.sub_account_id AND d.deleted_at IS NULL
   WHERE t.sub_account_id = $1 AND t.deleted_at IS NULL`;

const toTodo = (r: Row): Todo => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  dueOn: r.due_on,
  assigneeUserId: r.assignee_user_id,
  assigneeName: r.assignee_name,
  contactId: r.contact_id,
  contactName: r.contact_name,
  dealId: r.deal_id,
  dealTitle: r.deal_title,
  doneAt: r.done_at ? r.done_at.toISOString() : null,
  createdByUserId: r.created_by_user_id,
  automationId: r.automation_id,
  createdAt: r.created_at.toISOString(),
});

/**
 * Every open task, and those finished in the last `doneWithinDays` days.
 *
 * Completed tasks are kept briefly so a mis-tick can be undone from where it
 * happened; after that they are history, not work.
 */
export async function listTodos(
  q: TenantQuery,
  opts: { contactId?: string; dealId?: string; doneWithinDays?: number } = {}
): Promise<Todo[]> {
  const rows = await q.rows<Row>(
    `${SELECT}
       AND ($2::text IS NULL OR t.contact_id = $2)
       AND ($3::text IS NULL OR t.deal_id = $3)
       AND (t.done_at IS NULL OR t.done_at > now() - ($4 || ' days')::interval)
     ORDER BY t.done_at NULLS FIRST, t.due_on NULLS LAST, t.created_at, t.id`,
    [q.ctx.subAccountId, opts.contactId ?? null, opts.dealId ?? null, String(opts.doneWithinDays ?? 7)]
  );
  return rows.map(toTodo);
}

export async function getTodo(q: TenantQuery, id: string): Promise<Todo | null> {
  const row = await q.one<Row>(`${SELECT} AND t.id = $2`, [q.ctx.subAccountId, id]);
  return row ? toTodo(row) : null;
}

export type NewTodo = {
  title: string;
  notes?: string | null;
  dueOn?: string | null;
  assigneeUserId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  automationId?: string | null;
};

export async function createTodo(q: TenantQuery, input: NewTodo): Promise<Todo> {
  const id = `td_${crypto.randomUUID().replace(/-/g, "")}`;
  await q.rows(
    `INSERT INTO todos
       (id, sub_account_id, title, notes, due_on, assignee_user_id, contact_id, deal_id,
        created_by_user_id, automation_id)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10)`,
    [
      id,
      q.ctx.subAccountId,
      input.title,
      input.notes || null,
      input.dueOn ?? null,
      input.assigneeUserId ?? null,
      input.contactId ?? null,
      input.dealId ?? null,
      /* A rule acts as the workspace, not as whoever triggered it. */
      input.automationId ? null : q.ctx.userId || null,
      input.automationId ?? null,
    ]
  );
  const created = await getTodo(q, id);
  if (!created) throw new Error("The task was not created.");
  return created;
}

export async function updateTodo(
  q: TenantQuery,
  id: string,
  patch: { title: string; notes: string | null; dueOn: string | null; assigneeUserId: string | null }
): Promise<boolean> {
  const rows = await q.rows<{ id: string }>(
    `UPDATE todos
        SET title = $3, notes = $4, due_on = $5::date, assignee_user_id = $6, updated_at = now()
      WHERE sub_account_id = $1 AND id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [q.ctx.subAccountId, id, patch.title, patch.notes, patch.dueOn, patch.assigneeUserId]
  );
  return rows.length > 0;
}

/** Tick off, or untick. Records who finished it. */
export async function setTodoDone(q: TenantQuery, id: string, done: boolean): Promise<boolean> {
  const rows = await q.rows<{ id: string }>(
    `UPDATE todos
        SET done_at = CASE WHEN $3 THEN COALESCE(done_at, now()) ELSE NULL END,
            done_by_user_id = CASE WHEN $3 THEN COALESCE(done_by_user_id, $4) ELSE NULL END,
            updated_at = now()
      WHERE sub_account_id = $1 AND id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [q.ctx.subAccountId, id, done, q.ctx.userId || null]
  );
  return rows.length > 0;
}

export async function deleteTodo(q: TenantQuery, id: string): Promise<boolean> {
  const rows = await q.rows<{ id: string }>(
    `UPDATE todos SET deleted_at = now(), updated_at = now()
      WHERE sub_account_id = $1 AND id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return rows.length > 0;
}

/**
 * How many open tasks are one person's to do today or already late.
 *
 * `today` is the business's calendar day, passed in; see `todo-rules.ts`.
 */
export async function dueForUser(
  q: TenantQuery,
  userId: string,
  today: string
): Promise<{ dueToday: number; overdue: number }> {
  const row = await q.one<{ due_today: string; overdue: string }>(
    `SELECT count(*) FILTER (WHERE due_on = $3::date)::text AS due_today,
            count(*) FILTER (WHERE due_on < $3::date)::text  AS overdue
       FROM todos
      WHERE sub_account_id = $1 AND assignee_user_id = $2
        AND done_at IS NULL AND deleted_at IS NULL AND due_on IS NOT NULL`,
    [q.ctx.subAccountId, userId, today]
  );
  return { dueToday: Number(row?.due_today ?? 0), overdue: Number(row?.overdue ?? 0) };
}
