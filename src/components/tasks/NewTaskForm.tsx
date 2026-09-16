"use client";

import { useActionState, useRef } from "react";
import { Plus } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { addDays } from "@/server/todo-rules";
import { createTodoAction, type TaskFormState } from "@/app/(app)/tasks/actions";

type Person = { id: string; name: string };

/**
 * Add a task in one line.
 *
 * What it is is the only thing required. The day defaults to today — a task
 * with no day is the one that never gets done — and the person to whoever is
 * adding it, because most tasks people write down are their own. Both are one
 * tap to change.
 *
 * The form keeps itself open and clears on success, so a list of five things
 * can be typed one after another without reaching for the mouse.
 */
export function NewTaskForm({
  today,
  team,
  currentUserId,
  contactId,
  deals,
  compact = false,
  onDone,
}: {
  today: string;
  team: Person[];
  currentUserId: string | null;
  /** Pins the task to this contact; no record picker is shown. */
  contactId?: string;
  /** Open deals a task can be filed against, when not pinned to a contact. */
  deals?: { id: string; title: string }[];
  compact?: boolean;
  onDone?: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<TaskFormState, FormData>(async (prev, formData) => {
    const out = await createTodoAction(prev, formData);
    if (out?.ok) {
      formRef.current?.reset();
      formRef.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
      onDone?.();
    }
    return out;
  }, undefined);
  const meIsAssignable = team.some((p) => p.id === currentUserId);

  return (
    <form ref={formRef} action={action} className="space-y-3">
      {state?.error && <Banner state={state} />}
      {contactId && <input type="hidden" name="contactId" value={contactId} />}
      <div className="flex gap-2">
        <input
          name="title"
          required
          maxLength={200}
          autoFocus={compact}
          placeholder={contactId ? "What needs doing for them?" : "Add a task…"}
          aria-label="Task"
          className="field-input min-w-0 flex-1"
        />
        <button
          type="submit"
          disabled={pending}
          aria-label="Add task"
          className="btn-accent focus-ring flex shrink-0 items-center gap-1.5 rounded-xl px-4 text-sm font-semibold disabled:opacity-60"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden @min-[440px]:inline">{pending ? "Adding…" : "Add"}</span>
        </button>
      </div>
      <div className={compact ? "grid grid-cols-2 gap-2" : "grid grid-cols-2 gap-2 @min-[560px]:grid-cols-3"}>
        <label className="block min-w-0">
          <span className="sr-only">Due</span>
          <select name="dueOn" defaultValue={today} aria-label="Due" className="field-input">
            <option value={today}>Today</option>
            <option value={addDays(today, 1)}>Tomorrow</option>
            <option value={addDays(today, 2)}>In 2 days</option>
            <option value={addDays(today, 7)}>In a week</option>
            <option value="">No due date</option>
          </select>
        </label>
        <label className="block min-w-0">
          <span className="sr-only">Whose</span>
          <select name="assignee" defaultValue={meIsAssignable ? (currentUserId ?? "") : ""} aria-label="Whose" className="field-input">
            <option value="">Nobody yet</option>
            {/* "Me", not "Demo Owner (you)": on a phone the half-width select
                cut the name off, and your own name is the one you least need
                to read. */}
            {team.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === currentUserId ? "Me" : p.name}
              </option>
            ))}
          </select>
        </label>
        {!contactId && deals && deals.length > 0 && (
          <label className="col-span-2 block min-w-0 @min-[560px]:col-span-1">
            <span className="sr-only">About</span>
            <select name="dealId" defaultValue="" aria-label="About which deal" className="field-input">
              <option value="">Not about a deal</option>
              {deals.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {state?.ok && !compact && (
        <p className="text-xs" style={{ color: "var(--green)" }} role="status">
          {state.ok}
        </p>
      )}
    </form>
  );
}
