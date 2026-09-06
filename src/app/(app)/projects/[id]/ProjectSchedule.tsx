"use client";

import { useActionState, useMemo, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { clsx } from "@/lib/clsx";
import { useFormDisclosure } from "@/lib/form-disclosure";
import type { ProjectTask, ScheduleSummary } from "@/server/repos/tasks";
import {
  addTaskAction,
  deleteTaskAction,
  moveTaskAction,
  setTaskCompleteAction,
  updateTaskAction,
  type FormState,
} from "../actions";

/**
 * The plan, and how far through it the job is.
 *
 * Built from the schedule Bradley actually works to — a task list with a start,
 * a finish and a percentage on every row, drawn as bars against a date axis.
 * The chart is the point: a column of percentages tells you the numbers, and a
 * row of bars tells you whether the job is on time, which is the question
 * somebody opens this to ask.
 *
 * Everything is derived from the dates. There is no stored duration, no stored
 * total, and no stored "on track" flag — a schedule whose summary can disagree
 * with its own rows is worse than no summary.
 */

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` → days since epoch. Parsed as UTC so no zone can shift a day. */
const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / MS_PER_DAY);

/** "24 Aug" — short, because these repeat down a narrow axis. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}
const isoFor = (day: number) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);

export function ProjectSchedule({
  dealId,
  tasks,
  summary,
  today,
  staff,
}: {
  dealId: string;
  tasks: ProjectTask[];
  summary: ScheduleSummary;
  /** The business's own today, resolved on the server against its time zone. */
  today: string;
  staff: { id: string; name: string }[];
}) {
  const [editing, setEditing] = useState<ProjectTask | null>(null);

  const [addState, add, adding] = useActionState<FormState, FormData>(addTaskAction, undefined);
  const [editState, edit, editingBusy] = useActionState<FormState, FormData>(
    updateTaskAction,
    undefined
  );
  const [completeState, complete, completing] = useActionState<FormState, FormData>(
    setTaskCompleteAction,
    undefined
  );
  const [moveState, move] = useActionState<FormState, FormData>(moveTaskAction, undefined);
  const [removeState, remove, removing] = useActionState<FormState, FormData>(
    deleteTaskAction,
    undefined
  );
  const [addOpen, openAdd, closeAdd] = useFormDisclosure(addState, (s) => Boolean(s?.ok));

  /*
     The window the chart draws.

     Padded by a day at each end so a bar never touches the frame, and widened
     to include TODAY — a plan that finished last month still wants its "you are
     here" line visible, and one that starts in November should not draw an axis
     that pretends the present does not exist.
  */
  const range = useMemo(() => {
    const dated = tasks.filter((t) => t.startsOn && t.dueOn);
    if (dated.length === 0) return null;

    const starts = dated.map((t) => dayNumber(t.startsOn!));
    const ends = dated.map((t) => dayNumber(t.dueOn!));
    const todayDay = dayNumber(today);

    const from = Math.min(...starts, todayDay) - 1;
    const to = Math.max(...ends, todayDay) + 1;
    return { from, to, days: Math.max(1, to - from) };
  }, [tasks, today]);

  /*
     Ticks along the top.

     At most eight, spaced evenly, so a two-week plan and a two-year one both
     read without the labels colliding. Drawn from the range rather than from
     calendar months on purpose: an evenly divided axis is what makes a bar's
     position mean something.
  */
  const ticks = useMemo(() => {
    if (!range) return [];
    const count = Math.min(8, Math.max(2, Math.round(range.days / 7)));
    return Array.from({ length: count + 1 }, (_, i) => {
      const day = range.from + Math.round((range.days * i) / count);
      return { at: (i / count) * 100, label: shortDay(isoFor(day)) };
    });
  }, [range]);

  const todayAt = range
    ? ((dayNumber(today) - range.from) / range.days) * 100
    : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Progress"
          icon={<CalendarDays className="h-[18px] w-[18px] text-accent" />}
          action={
            <CardMeta value={summary.percentComplete === null ? "—" : `${summary.percentComplete}%`}>
              complete
            </CardMeta>
          }
        />

        {summary.tasks === 0 ? (
          <p className="text-sm text-muted">
            Nothing scheduled yet. Add the tasks this job is made of — each with a start, a finish
            and how far along it is — and the plan draws itself below.
          </p>
        ) : (
          <>
            {/*
                One bar for the whole job, above the per-task rows.

                Weighted by duration, so a ten-day task counts for ten times
                what a one-day task does. A plain average would call a job half
                built when the long task has not started.
            */}
            <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: "var(--raise)" }}>
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${summary.percentComplete ?? 0}%`,
                  backgroundImage: "linear-gradient(90deg,var(--accent-from),var(--accent-to))",
                }}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted">
              <span>
                <span className="font-semibold text-[var(--text)]">{summary.done}</span> of{" "}
                {summary.tasks} {summary.tasks === 1 ? "task" : "tasks"} done
              </span>
              {summary.startsOn && summary.dueOn && (
                <span>
                  {shortDay(summary.startsOn)} — {shortDay(summary.dueOn)}
                </span>
              )}
              {/* Only when there is something to say. A permanent "0 overdue"
                  is a number nobody reads and a badge that cries wolf. */}
              {summary.overdue > 0 && (
                <span className="font-semibold" style={{ color: "var(--red)" }}>
                  {summary.overdue} overdue
                </span>
              )}
            </div>
          </>
        )}
      </Card>

      <div className="flex flex-col gap-2 empty:hidden">
        <Banner state={completeState} />
        <Banner state={moveState} />
        <Banner state={removeState} />
        {!addOpen && <Banner state={addState} />}
        {!editing && <Banner state={editState} />}
      </div>

      {/* The chart. Its own card, and horizontally scrollable inside it — a
          long plan must never make the PAGE scroll sideways. */}
      {range && (
        <Card>
          <CardHeader
            title="Schedule"
            icon={<CalendarDays className="h-[18px] w-[18px] text-accent" />}
          />
          {/*
              On a phone the chart FITS rather than scrolls.

              At a 520px minimum the names took 214px of a 293px-wide scroller
              and the bars started past the right edge — measured: a five-week
              plan showed the first ten days and nothing else, so the one thing
              the chart exists to show was the thing you could not see. A
              horizontal scroller is honest for a long plan and useless as the
              default view of a short one.

              So below 560px the span is squeezed into the width available and
              the label column drops to 30%. Individual bars get small, and the
              staircase — which task, how far along, roughly when — still reads
              at a glance, with the exact dates on the list below. Above 560px
              nothing changes: the minimum width comes back and the scroller
              does its job.
          */}
          <div className="overflow-x-auto">
            <div className="@min-[560px]:min-w-[520px]">
              {/* The axis */}
              <div className="relative mb-2 ml-[30%] h-4 border-b border-[var(--border)] @min-[560px]:ml-[40%]">
                {/*
                    The end labels are pinned, not centred.

                    Every tick centred on its position means the first and last
                    hang half their width outside the axis — and the last one
                    was the entire reason the chart still scrolled sideways on a
                    phone by 16px, with "29 Sep" clipped to "29 S". Anchoring
                    the ends inward costs nothing: their position is the edge of
                    the range, which is unambiguous wherever the text sits.
                */}
                {ticks.map((t, i) => {
                  const first = i === 0;
                  const last = i === ticks.length - 1;
                  return (
                    <span
                      key={i}
                      className={clsx(
                        "absolute top-0 whitespace-nowrap text-[10px] text-faint",
                        !first && !last && "-translate-x-1/2",
                        last && "-translate-x-full"
                      )}
                      style={{ left: `${t.at}%` }}
                    >
                      {t.label}
                    </span>
                  );
                })}
              </div>

              <ul className="flex flex-col gap-1.5">
                {tasks.map((task) => {
                  const scheduled = task.startsOn && task.dueOn;
                  const left = scheduled
                    ? ((dayNumber(task.startsOn!) - range.from) / range.days) * 100
                    : 0;
                  const width = scheduled
                    ? ((dayNumber(task.dueOn!) - dayNumber(task.startsOn!) + 1) / range.days) * 100
                    : 0;
                  const done = task.percentComplete === 100;
                  const late = !done && task.dueOn !== null && task.dueOn < today;

                  return (
                    <li key={task.id} className="flex items-center gap-2">
                      <span
                        className={clsx(
                          "w-[30%] shrink-0 truncate pr-2 text-[11px] @min-[560px]:w-[40%] @min-[560px]:text-xs",
                          done ? "text-faint line-through" : "text-muted"
                        )}
                        title={task.name}
                      >
                        {task.name}
                      </span>

                      <span className="relative h-5 flex-1">
                        {/* Today, behind the bars. The single most useful mark
                            on a schedule: everything left of it should be done. */}
                        {todayAt !== null && todayAt >= 0 && todayAt <= 100 && (
                          <span
                            className="absolute top-0 h-full w-px"
                            style={{ left: `${todayAt}%`, background: "var(--border)" }}
                            aria-hidden
                          />
                        )}

                        {scheduled ? (
                          <span
                            className="absolute top-1/2 h-3 -translate-y-1/2 overflow-hidden rounded-full"
                            /*
                               The empty track needs to read as a planned span,
                               not as nothing.

                               At `--raise` alone a not-started task was very
                               nearly invisible against the card — which is the
                               wrong message entirely: those bars are the work
                               still to come, and a chart that shows only what
                               is finished cannot answer "are we on time". The
                               outline gives the span an edge at any fill.
                            */
                            style={{
                              left: `${left}%`,
                              width: `${Math.max(width, 1.5)}%`,
                              background: late ? "var(--red-soft)" : "var(--raise)",
                              boxShadow: "inset 0 0 0 1px var(--border)",
                            }}
                            title={`${shortDay(task.startsOn!)} — ${shortDay(task.dueOn!)} · ${task.percentComplete}%`}
                          >
                            {/* The fill IS the progress. A bar drawn at full
                                width in one colour would say when the work is
                                planned and nothing about whether it happened. */}
                            <span
                              className="block h-full rounded-full"
                              style={{
                                width: `${task.percentComplete}%`,
                                background: done
                                  ? "var(--green)"
                                  : late
                                    ? "var(--red)"
                                    : "var(--accent)",
                              }}
                            />
                          </span>
                        ) : (
                          <span className="absolute top-1/2 -translate-y-1/2 text-[10px] text-faint">
                            no dates
                          </span>
                        )}
                      </span>

                      <span
                        className={clsx(
                          "w-9 shrink-0 text-right text-[11px] tabular-nums",
                          done ? "text-[var(--green)]" : late ? "text-[var(--red)]" : "text-faint"
                        )}
                      >
                        {task.percentComplete}%
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </Card>
      )}

      {/* The list, where the work is actually edited. */}
      <Card>
        <CardHeader
          title="Tasks"
          icon={<Check className="h-[18px] w-[18px] text-accent" />}
          action={
            !addOpen && !editing ? (
              <button
                type="button"
                onClick={openAdd}
                className="btn-accent focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold"
              >
                <Plus className="h-3.5 w-3.5" />
                Add a task
              </button>
            ) : undefined
          }
        />

        {(addOpen || editing) && (
          <TaskForm
            dealId={dealId}
            task={editing}
            staff={staff}
            state={editing ? editState : addState}
            action={editing ? edit : add}
            busy={editing ? editingBusy : adding}
            onCancel={() => {
              setEditing(null);
              closeAdd();
            }}
          />
        )}

        {tasks.length === 0 ? (
          <p className="text-xs text-faint">No tasks yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((task, i) => {
              const done = task.percentComplete === 100;
              const late = !done && task.dueOn !== null && task.dueOn < today;
              return (
                <li
                  key={task.id}
                  className="flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5"
                  style={{ background: "var(--surface-2)" }}
                >
                  {/* Done is a form, not a checkbox input: it writes. */}
                  <form action={complete} className="shrink-0">
                    <input type="hidden" name="taskId" value={task.id} />
                    <input type="hidden" name="done" value={done ? "false" : "true"} />
                    <button
                      type="submit"
                      disabled={completing}
                      aria-label={done ? `Reopen ${task.name}` : `Mark ${task.name} done`}
                      className="focus-ring grid h-6 w-6 place-items-center rounded-md border transition-colors disabled:opacity-50"
                      style={{
                        borderColor: done ? "var(--green)" : "var(--border)",
                        background: done ? "var(--green-soft)" : "transparent",
                      }}
                    >
                      {done && <Check className="h-3.5 w-3.5" style={{ color: "var(--green)" }} />}
                    </button>
                  </form>

                  <div className="min-w-0 flex-1 leading-tight">
                    <p className={clsx("truncate text-sm", done && "text-faint line-through")}>
                      {task.name}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-faint">
                      {[
                        task.startsOn && task.dueOn
                          ? `${shortDay(task.startsOn)} — ${shortDay(task.dueOn)}`
                          : "No dates",
                        task.durationDays
                          ? `${task.durationDays} ${task.durationDays === 1 ? "day" : "days"}`
                          : null,
                        task.ownerName,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      {late && <span style={{ color: "var(--red)" }}> · overdue</span>}
                    </p>
                  </div>

                  <span className="shrink-0 text-xs font-semibold tabular-nums">
                    {task.percentComplete}%
                  </span>

                  <div className="flex shrink-0 items-center gap-1">
                    {/* Reordering by neighbour swap. Drag would be nicer on a
                        desktop and unusable with a thumb; this works on both. */}
                    <form action={move}>
                      <input type="hidden" name="dealId" value={dealId} />
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="direction" value="up" />
                      <button
                        type="submit"
                        disabled={i === 0}
                        aria-label={`Move ${task.name} up`}
                        className="btn-soft focus-ring rounded-lg p-1.5 text-muted disabled:opacity-30"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                    </form>
                    <form action={move}>
                      <input type="hidden" name="dealId" value={dealId} />
                      <input type="hidden" name="taskId" value={task.id} />
                      <input type="hidden" name="direction" value="down" />
                      <button
                        type="submit"
                        disabled={i === tasks.length - 1}
                        aria-label={`Move ${task.name} down`}
                        className="btn-soft focus-ring rounded-lg p-1.5 text-muted disabled:opacity-30"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </form>
                    <button
                      type="button"
                      onClick={() => {
                        closeAdd();
                        setEditing(task);
                      }}
                      aria-label={`Edit ${task.name}`}
                      className="btn-soft focus-ring rounded-lg p-1.5 text-muted transition-colors hover:text-accent"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <form action={remove}>
                      <input type="hidden" name="taskId" value={task.id} />
                      <button
                        type="submit"
                        disabled={removing}
                        aria-label={`Remove ${task.name}`}
                        className="btn-soft focus-ring rounded-lg p-1.5 text-muted transition-colors hover:text-red disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** One form for adding and for editing — two would be two places to fix a message. */
function TaskForm({
  dealId,
  task,
  staff,
  state,
  action,
  busy,
  onCancel,
}: {
  dealId: string;
  task: ProjectTask | null;
  staff: { id: string; name: string }[];
  state: FormState;
  action: (formData: FormData) => void;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <form action={action} key={task?.id ?? "new"} className="mb-3 space-y-3">
      <Banner state={state} />
      <input type="hidden" name="dealId" value={dealId} />
      {task && <input type="hidden" name="taskId" value={task.id} />}

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Task</span>
        <input
          name="name"
          defaultValue={task?.name ?? ""}
          placeholder="Radial arm drilling machine"
          required
          className="field-input"
        />
      </label>

      <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-[1fr_1fr_100px]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Starts</span>
          <input type="date" name="startsOn" defaultValue={task?.startsOn ?? ""} className="field-input" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Finishes</span>
          <input type="date" name="dueOn" defaultValue={task?.dueOn ?? ""} className="field-input" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">% done</span>
          <input
            type="number"
            name="percentComplete"
            min="0"
            max="100"
            step="5"
            defaultValue={task?.percentComplete ?? 0}
            className="field-input"
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Who is doing it</span>
        <select name="ownerUserId" defaultValue={task?.ownerUserId ?? ""} className="field-input">
          <option value="">Nobody yet</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-medium text-muted"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="btn-accent focus-ring rounded-xl px-5 py-2 text-sm font-semibold disabled:opacity-60"
        >
          {busy ? "Saving…" : task ? "Save" : "Add"}
        </button>
      </div>
    </form>
  );
}
