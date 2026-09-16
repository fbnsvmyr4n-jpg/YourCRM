import { SOURCES, STAGES, type Source, type Stage } from "./repos/deals";
import { SOURCE_LABEL } from "./leads-view";
import { stageMeta } from "@/data/pipeline";

/**
 * What an automation IS, with no database and no clock.
 *
 * Everything a rule decides — does it apply, whose turn is it, is it a rule
 * that makes sense at all, how is it said in English — lives here as plain
 * functions, so it can be tested exhaustively in milliseconds and shared with
 * the Settings screen, which has to describe a rule in exactly the words the
 * engine uses when it records what it did.
 */

export const EVENT_KINDS = ["lead_created", "deal_stage_changed"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const ACTION_KINDS = ["assign_owner", "move_stage"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * Stages a rule may move a deal INTO.
 *
 * Not Lost. A lost deal needs a reason, because the reasons are what the "why
 * we lose" report is built from, and a rule has no reason to give — it would
 * either be refused on every run or fill the report with "automation".
 */
export const MOVABLE_STAGES = STAGES.filter((s): s is Exclude<Stage, "lost"> => s !== "lost");

/** Enough for a real team's rotation; the schema refuses more. */
export const MAX_ASSIGNEES = 20;

/**
 * Per workspace. Rules run inside the request that caused them, so the number
 * is a bound on how much work one new lead can trigger — and past two dozen,
 * rules that contradict each other stop being findable by reading the list.
 */
export const MAX_AUTOMATIONS = 25;

/**
 * How many rules may act on each other's results within one change.
 *
 * A rule that moves Won to Delivery and another that moves Delivery to Won
 * would otherwise run until the request died. Each rule also acts at most once
 * per change, which stops that loop on its own; this is the backstop for a
 * chain of distinct rules nobody meant to build.
 */
export const MAX_CHAIN = 3;

export type Automation = {
  id: string;
  eventKind: EventKind;
  /** lead_created only. Null means any source. */
  whenSource: Source | null;
  /** deal_stage_changed only: the stage just moved into. */
  whenStage: Stage | null;
  actionKind: ActionKind;
  /** One person, or several in rotation. */
  assigneeIds: string[];
  targetStage: Stage | null;
  rotationPosition: number;
  enabled: boolean;
  createdAt: string;
};

/** The parts a person chooses; the rest is the engine's bookkeeping. */
export type AutomationDraft = Pick<
  Automation,
  "eventKind" | "whenSource" | "whenStage" | "actionKind" | "assigneeIds" | "targetStage"
>;

/** What happened, in the terms a rule matches on. */
export type RuleEvent =
  | { kind: "lead_created"; source: Source }
  | { kind: "deal_stage_changed"; to: Stage };

export function matches(rule: Automation, event: RuleEvent): boolean {
  if (!rule.enabled || rule.eventKind !== event.kind) return false;
  if (event.kind === "lead_created") {
    return rule.whenSource === null || rule.whenSource === event.source;
  }
  return rule.whenStage === event.to;
}

/**
 * Whose turn it is.
 *
 * Starts at `position` and walks forward past anybody who can no longer take
 * work — they left, or they moved to a role that cannot see customer records —
 * so one departure does not stall the rotation or hand that person's share to
 * nobody. The next turn starts AFTER whoever was chosen, which keeps the order
 * fair when somebody is stepped over: the people behind them do not lose their
 * place.
 *
 * Null when nobody on the list can take it. The caller treats that as a
 * failure a person must see, never as "leave it where it is" silently.
 */
export function pickAssignee(
  ids: readonly string[],
  position: number,
  eligible: ReadonlySet<string>
): { userId: string; nextPosition: number } | null {
  const n = ids.length;
  if (n === 0) return null;
  const start = ((Math.trunc(position) % n) + n) % n;
  for (let step = 0; step < n; step++) {
    const i = (start + step) % n;
    if (eligible.has(ids[i])) return { userId: ids[i], nextPosition: (i + 1) % n };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Checking a rule somebody built                                      */
/* ------------------------------------------------------------------ */

const blank = (v: unknown) => v === null || v === undefined || v === "" || v === "any";

/**
 * Turn what a form posted into a rule, or say what is wrong with it.
 *
 * The database refuses the same shapes (see `automations_event_shape` and
 * `automations_action_shape`); this exists so the refusal is a sentence on the
 * form rather than a constraint name. Whether the chosen PEOPLE belong to this
 * workspace needs the database, so the action checks that separately.
 */
export function checkDraft(raw: {
  eventKind: unknown;
  whenSource: unknown;
  whenStage: unknown;
  actionKind: unknown;
  assigneeIds: unknown[];
  targetStage: unknown;
}): { draft: AutomationDraft } | { error: string } {
  const eventKind = (EVENT_KINDS as readonly unknown[]).includes(raw.eventKind)
    ? (raw.eventKind as EventKind)
    : null;
  if (!eventKind) return { error: "Choose what should start this automation." };

  let whenSource: Source | null = null;
  let whenStage: Stage | null = null;
  if (eventKind === "lead_created") {
    if (!blank(raw.whenSource)) {
      if (!(SOURCES as readonly unknown[]).includes(raw.whenSource)) {
        return { error: "That is not a lead source this workspace records." };
      }
      whenSource = raw.whenSource as Source;
    }
  } else {
    if (!(STAGES as readonly unknown[]).includes(raw.whenStage)) {
      return { error: "Choose the stage that should start this automation." };
    }
    whenStage = raw.whenStage as Stage;
  }

  const actionKind = (ACTION_KINDS as readonly unknown[]).includes(raw.actionKind)
    ? (raw.actionKind as ActionKind)
    : null;
  if (!actionKind) return { error: "Choose what this automation should do." };

  if (actionKind === "assign_owner") {
    const ids = [
      ...new Set(raw.assigneeIds.filter((v): v is string => typeof v === "string" && v.length > 0)),
    ];
    if (ids.length === 0) return { error: "Choose who should get it." };
    if (ids.length > MAX_ASSIGNEES) {
      return { error: `A rotation can include up to ${MAX_ASSIGNEES} people.` };
    }
    return { draft: { eventKind, whenSource, whenStage, actionKind, assigneeIds: ids, targetStage: null } };
  }

  if (raw.targetStage === "lost") {
    return { error: "A rule cannot mark a deal lost — that needs a reason only a person can give." };
  }
  if (!(MOVABLE_STAGES as readonly unknown[]).includes(raw.targetStage)) {
    return { error: "Choose the stage to move it to." };
  }
  const targetStage = raw.targetStage as Stage;
  if (whenStage === targetStage) {
    return { error: "That would move a deal to the stage it has just arrived at." };
  }
  return { draft: { eventKind, whenSource, whenStage, actionKind, assigneeIds: [], targetStage } };
}

/* ------------------------------------------------------------------ */
/* Saying a rule in English                                            */
/* ------------------------------------------------------------------ */

export const sourceLabel = (source: Source) => SOURCE_LABEL[source];
export const stageLabel = (stage: Stage) => stageMeta(stage).label;

/**
 * A rule as two short lines: when, and then.
 *
 * The same words appear on the Settings list, in the run history and in the
 * note left on a deal, so a person who reads "Take turns: Sam, Kim" on a lead
 * finds the identical sentence on the rule that did it.
 *
 * `nameOf` answers for the people on the rule; anybody it cannot name has left,
 * and is said so rather than shown as an id.
 */
export function describeAutomation(
  rule: AutomationDraft,
  nameOf: (userId: string) => string | undefined
): { when: string; then: string } {
  const when =
    rule.eventKind === "lead_created"
      ? rule.whenSource
        ? `A new lead comes in from ${sourceLabel(rule.whenSource)}`
        : "A new lead comes in"
      : `A deal moves to ${stageLabel(rule.whenStage ?? "prospect")}`;

  if (rule.actionKind === "move_stage") {
    return { when, then: `Move it to ${stageLabel(rule.targetStage ?? "prospect")}` };
  }
  const names = rule.assigneeIds.map((id) => nameOf(id) ?? "someone who has left");
  return {
    when,
    then: names.length === 1 ? `Give it to ${names[0]}` : `Take turns: ${names.join(", ")}`,
  };
}
