"use server";

import { revalidateApp } from "@/server/revalidate";
import { withCurrentTenant } from "@/server/tenant-session";
import { assignableTeam } from "@/server/repos/automations";
import { createTodo, deleteTodo, getTodo, setTodoDone, updateTodo } from "@/server/repos/todos";
import { isIsoDay, MAX_NOTES, MAX_TITLE } from "@/server/todo-rules";
import { id as validId, multiline, text } from "@/server/validate";
import { logWrite } from "@/server/log";
import type { TenantQuery } from "@/server/tenant";

/**
 * Tasks: add, change, tick off, remove.
 *
 * Customer-data work, so the default CRM gate applies; within a workspace
 * anybody who works the CRM can manage any task, the same as contacts and
 * deals. A task is the team's list, not a private one.
 */

export type TaskFormState = { ok?: string; error?: string } | undefined;

type Fields = { title: string; notes: string | null; dueOn: string | null; assigneeUserId: string | null };

/**
 * The editable parts of a task, checked. The person must be somebody who can
 * be given work here — ids arrive from the browser, and a task handed to the
 * IT administrator is one nobody can open.
 */
async function readFields(q: TenantQuery, formData: FormData): Promise<Fields | { error: string }> {
  const title = text(formData.get("title"), MAX_TITLE);
  if (!title) return { error: "Say what needs doing." };

  const due = text(formData.get("dueOn"), 10);
  if (due && !isIsoDay(due)) return { error: "That due date is not a real day." };

  const assignee = text(formData.get("assignee"), 80);
  if (assignee) {
    const team = new Set((await assignableTeam(q)).map((p) => p.id));
    if (!team.has(assignee)) return { error: "That person cannot be given tasks in this workspace." };
  }

  return {
    title,
    notes: multiline(formData.get("notes"), MAX_NOTES) || null,
    dueOn: due || null,
    assigneeUserId: assignee || null,
  };
}

export async function createTodoAction(_prev: TaskFormState, formData: FormData): Promise<TaskFormState> {
  return withCurrentTenant(async (q) => {
    const fields = await readFields(q, formData);
    if ("error" in fields) return { error: fields.error };

    const contactRaw = text(formData.get("contactId"), 80);
    const dealRaw = text(formData.get("dealId"), 80);
    const contactId = contactRaw ? validId(contactRaw) : null;
    const dealId = dealRaw ? validId(dealRaw) : null;
    if ((contactRaw && !contactId) || (dealRaw && !dealId)) return { error: "That record could not be found." };

    try {
      /* In a savepoint: a contact or deal from elsewhere is refused by the
         database, and that refusal must become a sentence rather than a broken
         request. */
      const created = await q.attempt(() => createTodo(q, { ...fields, contactId, dealId }));
      logWrite("create", "todo", { id: created.id, actor: q.ctx.userId });
    } catch (err) {
      if ((err as { code?: string }).code === "23514") return { error: "That record could not be found." };
      throw err;
    }
    revalidateApp();
    return { ok: "Task added." };
  });
}

export async function updateTodoAction(_prev: TaskFormState, formData: FormData): Promise<TaskFormState> {
  return withCurrentTenant(async (q) => {
    const todoId = validId(formData.get("id"));
    if (!todoId || !(await getTodo(q, todoId))) return { error: "That task no longer exists." };
    const fields = await readFields(q, formData);
    if ("error" in fields) return { error: fields.error };

    await updateTodo(q, todoId, fields);
    logWrite("update", "todo", { id: todoId, actor: q.ctx.userId });
    revalidateApp();
    return { ok: "Saved." };
  });
}

/** Tick or untick. Returns whether it happened, for the optimistic checkbox. */
export async function setTodoDoneAction(id: string, done: boolean): Promise<{ ok: boolean }> {
  return withCurrentTenant(async (q) => {
    const todoId = validId(id);
    if (!todoId || typeof done !== "boolean") return { ok: false };
    const changed = await setTodoDone(q, todoId, done);
    if (changed) {
      logWrite("update", "todo", { id: todoId, actor: q.ctx.userId });
      revalidateApp();
    }
    return { ok: changed };
  });
}

export async function deleteTodoAction(_prev: TaskFormState, formData: FormData): Promise<TaskFormState> {
  return withCurrentTenant(async (q) => {
    const todoId = validId(formData.get("id"));
    if (!todoId || !(await deleteTodo(q, todoId))) return { error: "That task no longer exists." };
    logWrite("delete", "todo", { id: todoId, actor: q.ctx.userId });
    revalidateApp();
    return { ok: "Deleted." };
  });
}
