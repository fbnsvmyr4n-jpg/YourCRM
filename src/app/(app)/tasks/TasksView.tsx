"use client";

import { useState } from "react";
import { ChevronDown, ListChecks } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { NewTaskForm } from "@/components/tasks/NewTaskForm";
import { TaskItem } from "@/components/tasks/TaskItem";
import { clsx } from "@/lib/clsx";
import { useRememberedToggle } from "@/lib/remembered-toggle";
import { bucketOf, sortTodos, type Bucket, type Todo } from "@/server/todo-rules";

type Person = { id: string; name: string };

/**
 * Everything that needs doing, in the order it needs doing.
 *
 * Grouped by when rather than listed by date, because the question on arriving
 * is "what is late, and what is today" — a single sorted list answers it only
 * after reading the dates. Late first, in red, because a late task is the only
 * kind that is already costing something.
 *
 * Mine by default: most people come here for their own day. Everyone is a tap
 * away for whoever is covering or checking in.
 */

const GROUPS: { id: Exclude<Bucket, "done">; label: string; tone?: string }[] = [
  { id: "overdue", label: "Overdue", tone: "var(--red)" },
  { id: "today", label: "Today", tone: "var(--accent)" },
  { id: "upcoming", label: "Coming up" },
  { id: "undated", label: "No due date" },
];

export function TasksView({
  todos,
  today,
  team,
  currentUserId,
  deals,
}: {
  todos: Todo[];
  today: string;
  team: Person[];
  currentUserId: string;
  deals: { id: string; title: string }[];
}) {
  const [everyone, toggleEveryone] = useRememberedToggle("tasks:everyone", false);
  const [showDone, setShowDone] = useState(false);

  const mine = todos.filter((t) => t.assigneeUserId === currentUserId);
  const shown = sortTodos(everyone ? todos : mine);
  const open = shown.filter((t) => !t.doneAt);
  const done = shown.filter((t) => t.doneAt);
  const openCount = (list: Todo[]) => list.filter((t) => !t.doneAt).length;

  return (
    <div className="mx-auto max-w-[860px] animate-fade-up">
      <div className="pb-4 pt-1">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Tasks</h1>
        <p className="mt-1 text-sm text-muted">What needs doing, by whom and by when.</p>
      </div>

      <Card className="card-q">
        <NewTaskForm today={today} team={team} currentUserId={currentUserId} deals={deals} />
      </Card>

      <div className="mt-4 grid grid-cols-2 gap-1.5 @min-[440px]:inline-grid @min-[440px]:w-auto">
        {[
          { on: !everyone, label: "Mine", count: openCount(mine) },
          { on: everyone, label: "Everyone", count: openCount(todos) },
        ].map((tab) => (
          <button
            key={tab.label}
            type="button"
            aria-pressed={tab.on}
            onClick={() => {
              if (!tab.on) toggleEveryone();
            }}
            className={clsx(
              "focus-ring rounded-xl px-4 py-2 text-sm font-medium transition-colors",
              tab.on ? "text-accent" : "btn-soft text-muted"
            )}
            style={tab.on ? { background: "var(--accent-soft)" } : undefined}
          >
            {tab.label}
            <span className="ml-1.5 tabular-nums text-xs opacity-70">{tab.count}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-4">
        {/* One card, the groups divided by a rule. A card per group spent a
            screen on three tasks — the padding of four cards around a handful
            of rows — which is the opposite of what a list you glance at needs. */}
        <Card className="card-q">
          {open.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <span className="grid h-11 w-11 place-items-center rounded-full" style={{ background: "var(--green-soft)" }}>
                <ListChecks className="h-5 w-5" style={{ color: "var(--green)" }} />
              </span>
              <p className="text-sm font-medium">{everyone ? "Nothing open for anybody." : "Nothing open for you."}</p>
              <p className="max-w-[340px] text-xs text-faint">
                Add one above, or from a contact under More. Automations can add them too — a call-back for every new lead, say.
              </p>
            </div>
          ) : (
            GROUPS.map((group) => ({ group, items: open.filter((t) => bucketOf(t, today) === group.id) }))
              .filter(({ items }) => items.length > 0)
              .map(({ group, items }, i) => (
                <section
                  key={group.id}
                  aria-label={group.label}
                  className={clsx(i > 0 && "mt-3 border-t border-[var(--border)] pt-3")}
                >
                  <h3
                    className="px-0.5 text-[11px] font-semibold uppercase tracking-[0.14em]"
                    style={{ color: group.tone ?? "var(--text-faint)" }}
                  >
                    {group.label} <span className="ml-1 tabular-nums opacity-70">{items.length}</span>
                  </h3>
                  <ul className="-mx-2 mt-1 flex flex-col">
                    {items.map((todo) => (
                      <TaskItem
                        key={todo.id}
                        todo={todo}
                        today={today}
                        team={team}
                        currentUserId={currentUserId}
                        showAssignee={everyone}
                      />
                    ))}
                  </ul>
                </section>
              ))
          )}
        </Card>

        {done.length > 0 && (
          <Card className="card-q">
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              aria-expanded={showDone}
              className="focus-ring flex w-full items-center justify-between gap-3 rounded-lg text-left"
            >
              <span className="text-[15px] font-semibold tracking-tight text-muted">
                Done this week <span className="ml-1 text-sm font-normal tabular-nums text-faint">{done.length}</span>
              </span>
              <ChevronDown className={clsx("h-4 w-4 text-faint transition-transform", showDone && "rotate-180")} />
            </button>
            {showDone && (
              <ul className="-mx-2 mt-2 flex flex-col">
                {done.map((todo) => (
                  <TaskItem key={todo.id} todo={todo} today={today} team={team} currentUserId={currentUserId} showAssignee={everyone} />
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
