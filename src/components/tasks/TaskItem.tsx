"use client";

import { useActionState, useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { Check, Pencil, Trash2, Zap } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { clsx } from "@/lib/clsx";
import { useFormDisclosure } from "@/lib/form-disclosure";
import { bucketOf, dueLabel, type Todo } from "@/server/todo-rules";
import {
  deleteTodoAction,
  setTodoDoneAction,
  updateTodoAction,
  type TaskFormState,
} from "@/app/(app)/tasks/actions";

type Person = { id: string; name: string };

/**
 * One task: a tick, what it is, when, whose, and what it is about.
 *
 * Shared by the Tasks page and the contact panel so a task looks and behaves
 * the same wherever it is ticked off. The tick is optimistic — it moves at the
 * speed of the tap — and the server's answer settles it; a tick that could not
 * be saved springs back rather than pretending.
 */
export function TaskItem({
  todo,
  today,
  team,
  currentUserId,
  showAssignee = true,
  showRecord = true,
}: {
  todo: Todo;
  /** The business's calendar day. */
  today: string;
  team: Person[];
  currentUserId: string | null;
  showAssignee?: boolean;
  showRecord?: boolean;
}) {
  const [done, setDone] = useOptimistic(Boolean(todo.doneAt));
  const [ticking, startTick] = useTransition();
  const [editState, edit, saving] = useActionState<TaskFormState, FormData>(updateTodoAction, undefined);
  const [deleteState, remove, removing] = useActionState<TaskFormState, FormData>(deleteTodoAction, undefined);
  const [editing, openEdit, closeEdit] = useFormDisclosure(editState, (s) => Boolean(s?.ok));
  const [confirming, setConfirming] = useState(false);

  const bucket = done ? "done" : bucketOf(todo, today);
  const tick = () =>
    startTick(async () => {
      setDone(!done);
      await setTodoDoneAction(todo.id, !done);
    });

  if (editing) {
    return (
      <li className="rounded-xl px-3.5 py-3" style={{ background: "var(--surface-2)" }}>
        <form action={edit} className="space-y-3">
          {editState?.error && <Banner state={editState} />}
          <input type="hidden" name="id" value={todo.id} />
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Task</span>
            <input name="title" defaultValue={todo.title} maxLength={200} required className="field-input" />
          </label>
          <div className="grid grid-cols-1 gap-3 @min-[440px]:grid-cols-2">
            <label className="block min-w-0">
              <span className="mb-1.5 block text-xs font-medium text-muted">Due</span>
              <input name="dueOn" type="date" defaultValue={todo.dueOn ?? ""} className="field-input" />
            </label>
            <label className="block min-w-0">
              <span className="mb-1.5 block text-xs font-medium text-muted">Whose</span>
              <select name="assignee" defaultValue={todo.assigneeUserId ?? ""} className="field-input">
                <option value="">Nobody yet</option>
                {team.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === currentUserId ? "Me" : p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Notes</span>
            <textarea name="notes" defaultValue={todo.notes ?? ""} rows={2} maxLength={2000} className="field-input resize-y" />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeEdit} className="focus-ring rounded-xl px-4 py-2 text-xs font-medium text-muted">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-accent focus-ring rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-60">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </li>
    );
  }

  const assignee = todo.assigneeUserId === currentUserId ? "You" : todo.assigneeName;

  return (
    <li className="group flex items-start gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-[var(--raise)]">
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Mark “${todo.title}” not done` : `Mark “${todo.title}” done`}
        onClick={tick}
        disabled={ticking}
        className={clsx(
          "focus-ring mt-0.5 grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full border-2 transition-colors",
          done ? "border-transparent" : "border-[var(--border-strong)] hover:border-[var(--accent)]"
        )}
        style={done ? { background: "var(--green)" } : undefined}
      >
        {done && <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />}
      </button>

      <div className="min-w-0 flex-1 leading-tight">
        <p className={clsx("text-sm font-medium", done && "text-faint line-through")}>{todo.title}</p>
        {todo.notes && !done && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{todo.notes}</p>}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-faint">
          <span
            className={clsx("font-medium", bucket === "overdue" && "text-[var(--red)]", bucket === "today" && "text-accent")}
          >
            {done ? "Done" : dueLabel(todo.dueOn, today)}
          </span>
          {showAssignee && (
            <span>· {assignee ?? "Nobody yet"}</span>
          )}
          {showRecord && todo.contactId && todo.contactName && (
            <Link href={`/contacts?c=${encodeURIComponent(todo.contactId)}`} className="focus-ring rounded hover:text-accent">
              · {todo.contactName}
            </Link>
          )}
          {showRecord && todo.dealId && todo.dealTitle && (
            <Link href={`/projects/${encodeURIComponent(todo.dealId)}`} className="focus-ring rounded hover:text-accent">
              · {todo.dealTitle}
            </Link>
          )}
          {todo.automationId !== null && (
            <span className="inline-flex items-center gap-1" title="Created by an automation">
              · <Zap className="h-3 w-3" aria-hidden /> Automation
            </span>
          )}
        </p>
        {(editState?.ok || deleteState?.error) && (
          <p className="mt-1 text-xs" style={{ color: deleteState?.error ? "var(--red)" : "var(--green)" }}>
            {deleteState?.error ?? editState?.ok}
          </p>
        )}
      </div>

      <div
        className={clsx(
          "flex shrink-0 items-center gap-1 transition-opacity",
          confirming ? "opacity-100" : "opacity-100 @min-[560px]:opacity-0 @min-[560px]:group-hover:opacity-100 @min-[560px]:group-focus-within:opacity-100"
        )}
      >
        {confirming ? (
          <form action={remove} className="flex items-center gap-1">
            <input type="hidden" name="id" value={todo.id} />
            <button
              type="submit"
              disabled={removing}
              className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-60"
              style={{ background: "var(--red-soft)", color: "var(--red)" }}
            >
              {removing ? "Deleting…" : "Delete"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="focus-ring rounded-lg px-2 py-1.5 text-xs font-medium text-muted">
              Keep
            </button>
          </form>
        ) : (
          <>
            {!done && (
              <button type="button" onClick={openEdit} aria-label={`Edit “${todo.title}”`} className="focus-ring grid h-8 w-8 place-items-center rounded-lg text-faint hover:text-accent">
                <Pencil className="h-4 w-4" />
              </button>
            )}
            <button type="button" onClick={() => setConfirming(true)} aria-label={`Delete “${todo.title}”`} className="focus-ring grid h-8 w-8 place-items-center rounded-lg text-faint hover:text-[var(--red)]">
              <Trash2 className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </li>
  );
}
