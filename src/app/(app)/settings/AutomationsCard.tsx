"use client";

import { useActionState, useState } from "react";
import { Plus, Trash2, Zap } from "lucide-react";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { clsx } from "@/lib/clsx";
import { useFormDisclosure } from "@/lib/form-disclosure";
import { SOURCES, STAGES } from "@/server/repos/deals";
import {
  describeAutomation,
  MOVABLE_STAGES,
  sourceLabel,
  stageLabel,
  type ActionKind,
  type Automation,
  type EventKind,
} from "@/server/automation-rules";
import type { AutomationRun } from "@/server/repos/automations";
import type { FormState } from "./actions";
import {
  createAutomationAction,
  deleteAutomationAction,
  setAutomationEnabledAction,
} from "./automation-actions";

/**
 * Automations: the rules, a way to add one, and what they have done.
 *
 * Each rule reads as a sentence in two lines — when, then — in the same words
 * the engine writes on the deal it acts on, so a person who finds "Assigned to
 * Sam Lee, by the automation …" on a lead can find the rule that did it here
 * without translating between two vocabularies.
 */

type Person = { id: string; name: string };
type RunView = AutomationRun & { when: string };

const field =
  "focus-ring w-full rounded-lg border border-[var(--border)] bg-[var(--panel-solid)] px-3 py-2 text-sm";

export function AutomationsCard({
  automations,
  runs,
  team,
  canManage,
}: {
  automations: Automation[];
  runs: RunView[];
  /** Everybody a rule may hand work to. Also names the people on existing rules. */
  team: Person[];
  canManage: boolean;
}) {
  const nameOf = (personId: string) => team.find((p) => p.id === personId)?.name;
  const on = automations.filter((a) => a.enabled).length;

  return (
    <>
      <Card className="card-q">
        <CardHeader
          title="Automations"
          icon={<Zap className="h-[18px] w-[18px] text-accent" />}
          action={automations.length > 0 ? <CardMeta value={on}>on</CardMeta> : undefined}
        />

        {automations.length === 0 ? (
          <p className="mb-4 text-xs text-faint">
            Nothing runs on its own yet. An automation can hand each new lead to the right person the
            moment it arrives, or move a deal on when it reaches a stage.
          </p>
        ) : (
          <ul className="mb-4 flex flex-col gap-2">
            {automations.map((rule) => (
              <RuleRow key={rule.id} rule={rule} nameOf={nameOf} canManage={canManage} />
            ))}
          </ul>
        )}

        {canManage ? (
          <NewAutomation team={team} />
        ) : (
          <p className="text-xs text-faint">Only somebody who manages the team can add or change automations.</p>
        )}
      </Card>

      {runs.length > 0 && <RunsCard runs={runs} />}
    </>
  );
}

function RuleRow({
  rule,
  nameOf,
  canManage,
}: {
  rule: Automation;
  nameOf: (personId: string) => string | undefined;
  canManage: boolean;
}) {
  const { when, then } = describeAutomation(rule, nameOf);
  const [toggleState, toggle, toggling] = useActionState<FormState, FormData>(setAutomationEnabledAction, undefined);
  const [deleteState, remove, removing] = useActionState<FormState, FormData>(deleteAutomationAction, undefined);
  const [confirming, setConfirming] = useState(false);
  const error = toggleState?.error ?? deleteState?.error;

  return (
    <li className="rounded-xl px-3.5 py-3" style={{ background: "var(--surface-2)" }}>
      <div className="flex items-center gap-3">
        <div className={clsx("min-w-0 flex-1 leading-tight", !rule.enabled && "opacity-60")}>
          <p className="text-sm font-medium">{when}</p>
          <p className="mt-0.5 text-xs text-muted">{then}</p>
        </div>

        {canManage ? (
          <>
            <form action={toggle} className="flex shrink-0">
              <input type="hidden" name="id" value={rule.id} />
              <input type="hidden" name="enabled" value={rule.enabled ? "false" : "true"} />
              <button
                type="submit"
                role="switch"
                aria-checked={rule.enabled}
                aria-label={`${when}, ${then}`}
                disabled={toggling}
                className="focus-ring relative h-6 w-10 rounded-full transition-colors disabled:opacity-60"
                style={{ background: rule.enabled ? "var(--accent)" : "var(--border-strong)" }}
              >
                <span
                  className={clsx(
                    "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] motion-reduce:transition-none",
                    rule.enabled ? "left-[18px]" : "left-0.5"
                  )}
                />
              </button>
            </form>

            {confirming ? (
              <form action={remove} className="flex shrink-0 items-center gap-1">
                <input type="hidden" name="id" value={rule.id} />
                <button
                  type="submit"
                  disabled={removing}
                  className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-60"
                  style={{ background: "var(--red-soft)", color: "var(--red)" }}
                >
                  {removing ? "Deleting…" : "Delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="focus-ring rounded-lg px-2 py-1.5 text-xs font-medium text-muted"
                >
                  Keep
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                aria-label="Delete this automation"
                className="btn-soft focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </>
        ) : (
          <span className="shrink-0 text-xs font-medium text-faint">{rule.enabled ? "On" : "Off"}</span>
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}
    </li>
  );
}

function NewAutomation({ team }: { team: Person[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createAutomationAction, undefined);
  const [open, show, hide] = useFormDisclosure(state, (s) => Boolean(s?.ok));
  const [eventKind, setEventKind] = useState<EventKind>("lead_created");
  const [actionKind, setActionKind] = useState<ActionKind>("assign_owner");
  /* In the order they were ticked, because that is the order they take turns. */
  const [chosen, setChosen] = useState<string[]>([]);
  const nameOf = (personId: string) => team.find((p) => p.id === personId)?.name ?? "";

  if (!open) {
    return (
      <div className="space-y-3">
        <Banner state={state} />
        <button
          type="button"
          onClick={() => {
            setEventKind("lead_created");
            setActionKind("assign_owner");
            setChosen([]);
            show();
          }}
          className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-medium"
        >
          <Plus className="h-4 w-4 text-accent" />
          New automation
        </button>
      </div>
    );
  }

  const label = "mb-1.5 block text-xs font-medium text-muted";

  return (
    <form action={action} className="space-y-4 rounded-xl border border-[var(--border)] p-3.5">
      {state?.error && <Banner state={state} />}

      <div className="grid grid-cols-1 gap-4 @min-[560px]:grid-cols-2">
        <fieldset className="min-w-0 space-y-2">
          <legend className={label}>When</legend>
          <select
            name="eventKind"
            value={eventKind}
            onChange={(e) => setEventKind(e.target.value as EventKind)}
            aria-label="When"
            className={field}
          >
            <option value="lead_created">A new lead comes in</option>
            <option value="deal_stage_changed">A deal moves to a stage</option>
          </select>
          {eventKind === "lead_created" ? (
            <select name="whenSource" defaultValue="any" aria-label="From which source" className={field}>
              <option value="any">From any source</option>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  From {sourceLabel(s)}
                </option>
              ))}
            </select>
          ) : (
            <select name="whenStage" defaultValue="won" aria-label="Which stage" className={field}>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  Into {stageLabel(s)}
                </option>
              ))}
            </select>
          )}
        </fieldset>

        <fieldset className="min-w-0 space-y-2">
          <legend className={label}>Then</legend>
          <select
            name="actionKind"
            value={actionKind}
            onChange={(e) => setActionKind(e.target.value as ActionKind)}
            aria-label="Then"
            className={field}
          >
            <option value="assign_owner">Give it to somebody</option>
            <option value="move_stage">Move it to a stage</option>
          </select>
          {actionKind === "move_stage" ? (
            <select
              key={eventKind}
              name="targetStage"
              defaultValue={eventKind === "deal_stage_changed" ? "delivery" : "discovery"}
              aria-label="Which stage to move it to"
              className={field}
            >
              {MOVABLE_STAGES.map((s) => (
                <option key={s} value={s}>
                  {stageLabel(s)}
                </option>
              ))}
            </select>
          ) : (
            <p className="py-2 text-xs text-faint">
              {chosen.length > 1
                ? `They take turns: ${chosen.map(nameOf).join(", ")}.`
                : "Pick one person, or several to take turns."}
            </p>
          )}
        </fieldset>
      </div>

      {actionKind === "assign_owner" &&
        (team.length === 0 ? (
          <p className="text-xs text-faint">Nobody in this workspace can be given leads yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-1.5 @min-[440px]:grid-cols-2 @min-[720px]:grid-cols-3">
            {chosen.map((personId) => (
              <input key={personId} type="hidden" name="assignee" value={personId} />
            ))}
            {team.map((person) => {
              const checked = chosen.includes(person.id);
              return (
                <label
                  key={person.id}
                  className={clsx(
                    "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm",
                    checked ? "font-medium text-accent" : "btn-soft"
                  )}
                  style={checked ? { background: "var(--accent-soft)" } : undefined}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setChosen((list) =>
                        checked ? list.filter((x) => x !== person.id) : [...list, person.id]
                      )
                    }
                    className="focus-ring h-4 w-4 shrink-0 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 truncate">{person.name}</span>
                  {checked && chosen.length > 1 && (
                    <span className="ml-auto text-xs tabular-nums" aria-label={`turn ${chosen.indexOf(person.id) + 1}`}>
                      {chosen.indexOf(person.id) + 1}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        ))}

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={hide} className="focus-ring rounded-xl px-4 py-2.5 text-sm font-medium text-muted">
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save automation"}
        </button>
      </div>
    </form>
  );
}

const OUTCOME_TONE = {
  done: "var(--green)",
  skipped: "var(--text-faint)",
  failed: "var(--red)",
} as const;

const OUTCOME_WORD = { done: "Done", skipped: "Skipped", failed: "Failed" } as const;

function RunsCard({ runs }: { runs: RunView[] }) {
  return (
    <Card className="card-q">
      <CardHeader title="What they did" />
      <ul className="flex flex-col divide-y divide-[var(--border)]">
        {runs.map((run) => (
          <li key={run.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
            <span
              aria-hidden
              className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
              style={{ background: OUTCOME_TONE[run.outcome] }}
            />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="text-sm" style={run.outcome === "failed" ? { color: "var(--red)" } : undefined}>
                <span className="sr-only">{OUTCOME_WORD[run.outcome]}: </span>
                {run.detail}
              </p>
              <p className="mt-0.5 truncate text-xs text-faint">
                {run.dealId && run.dealTitle ? (
                  <a href={`/projects/${run.dealId}`} className="focus-ring rounded hover:underline">
                    {run.dealTitle}
                  </a>
                ) : (
                  "A deal that has since been deleted"
                )}
                {" · "}
                <span className="tabular-nums">{run.when}</span>
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
