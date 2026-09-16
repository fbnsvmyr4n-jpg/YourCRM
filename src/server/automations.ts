import type { TenantQuery } from "./tenant";
import { assignOwner as assignDealOwner, getDeal, moveStage, type DealRecord } from "./repos/deals";
import { assignOwner as assignContactOwner, getContact } from "./repos/contacts";
import { logActivity } from "./repos/activity";
import {
  advanceRotation,
  assignableTeam,
  automationsFor,
  recordRun,
  type RunOutcome,
} from "./repos/automations";
import {
  describeAutomation,
  matches,
  MAX_CHAIN,
  pickAssignee,
  stageLabel,
  type Automation,
  type RuleEvent,
} from "./automation-rules";
import { listenForDealEvents, type Chain, type DealEvent } from "./deal-events";
import { logFailure } from "./log";
import { createTodo } from "./repos/todos";
import { getSettings } from "./repos/settings";
import { addDays } from "./todo-rules";
import { instantToWallClock } from "@/lib/zoned";

/**
 * The automation engine.
 *
 * Runs INSIDE the transaction of whatever caused the event. Every action it
 * can take is a change to this database, so there is nothing to queue: a lead
 * and the person it was given to commit together, and if the request fails the
 * assignment never happened either.
 *
 * Three promises it keeps:
 *
 *  1. **A rule never breaks the thing that set it off.** Each rule runs in a
 *     savepoint. If it fails — nobody left in its rotation, a deal deleted in
 *     the meantime — its half-done work is rolled back, the failure is
 *     recorded, and the lead the visitor just submitted is still saved.
 *
 *  2. **Nothing it does is silent.** Every run leaves a row saying what
 *     happened, and every change leaves a note on the deal naming the rule.
 *     Failures reach the notification feed.
 *
 *  3. **It cannot loop.** A rule that moves a deal raises another event; the
 *     chain of rules already involved travels with it, a rule never acts twice
 *     in one change, and the chain has a hard length.
 */

/** A problem worth showing a person as it is. Anything else is summarised. */
class AutomationProblem extends Error {}

type Applied = { outcome: RunOutcome; detail: string; deal: DealRecord };

export async function runAutomations(q: TenantQuery, event: DealEvent, chain: Chain = []): Promise<void> {
  const ruleEvent: RuleEvent =
    event.kind === "lead_created"
      ? { kind: "lead_created", source: event.deal.source }
      : { kind: "deal_stage_changed", to: event.deal.stage };

  const rules = (await automationsFor(q, event.kind)).filter((r) => matches(r, ruleEvent));
  if (rules.length === 0) return;

  /* Read once per event, and only when a rule actually needs names. */
  let team: Map<string, string> | null = null;
  const teamNames = async () => (team ??= new Map((await assignableTeam(q)).map((u) => [u.id, u.name])));

  let deal = event.deal;
  for (const rule of rules) {
    if (chain.includes(rule.id) || chain.length >= MAX_CHAIN) {
      await recordRun(q, {
        automationId: rule.id,
        dealId: deal.id,
        outcome: "skipped",
        detail: "Not run: automations were already moving this deal back and forth.",
      });
      continue;
    }

    try {
      const applied = await q.attempt(() => apply(q, rule, deal, [...chain, rule.id], teamNames));
      deal = applied.deal;
      await recordRun(q, { automationId: rule.id, dealId: deal.id, outcome: applied.outcome, detail: applied.detail });
    } catch (err) {
      const known = err instanceof AutomationProblem;
      if (!known) {
        /* No record contents: the rule and the deal are identified by id. */
        logFailure("automation", `rule ${rule.id} on deal ${deal.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await recordRun(q, {
        automationId: rule.id,
        dealId: deal.id,
        outcome: "failed",
        detail: known ? (err as Error).message : "Something went wrong running this automation. Nothing was changed.",
      });
    }
  }
}

async function apply(
  q: TenantQuery,
  rule: Automation,
  deal: DealRecord,
  chain: Chain,
  teamNames: () => Promise<Map<string, string>>
): Promise<Applied> {
  const names = await teamNames();
  const sentence = describeAutomation(rule, (id) => names.get(id));
  const signature = `By the automation “${sentence.when} → ${sentence.then}”`;

  if (rule.actionKind === "assign_owner") {
    const pick = pickAssignee(rule.assigneeIds, rule.rotationPosition, new Set(names.keys()));
    if (!pick) {
      throw new AutomationProblem(
        "Nobody on this automation can take work any more. Choose who should get it instead."
      );
    }
    /* Moved on inside the savepoint, so a turn is only used up by an
       assignment that actually happened. */
    if (rule.assigneeIds.length > 1) await advanceRotation(q, rule.id, pick.nextPosition);

    const name = names.get(pick.userId)!;
    if (deal.ownerUserId === pick.userId) {
      return { outcome: "done", detail: `Already with ${name}`, deal };
    }

    const previous = deal.ownerUserId;
    const assigned = await assignDealOwner(q, deal.id, pick.userId);
    if (!assigned.record) throw new AutomationProblem(assigned.error ?? "That deal no longer exists.");

    /* The person follows the lead only when nobody else has a claim on them.
       A new enquirer is owned by whoever the deal was created under; an
       existing client with somebody's name against them keeps it — a rule
       about new leads is not a reason to take a relationship off a colleague. */
    if (deal.contactId) {
      const contact = await getContact(q, deal.contactId);
      if (contact && (contact.ownerUserId === null || contact.ownerUserId === previous)) {
        await assignContactOwner(q, contact.id, pick.userId);
      }
    }

    await logActivity(q, {
      entityType: "deal",
      entityId: deal.id,
      kind: "updated",
      title: `Assigned to ${name}`,
      detail: signature,
      actorUserId: null,
    });
    return { outcome: "done", detail: `Assigned to ${name}`, deal: assigned.record };
  }

  if (rule.actionKind === "create_task") {
    /* Due on the BUSINESS's calendar, counted from today there. */
    const settings = await getSettings(q);
    const today =
      instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
      new Date().toISOString().slice(0, 10);
    const dueOn = addDays(today, rule.taskDueDays ?? 0);

    /* Whoever owns the deal now — possibly just chosen by an earlier rule. An
       owner who can no longer take work is not handed it: the task is left
       for nobody, where it shows on the team's list, rather than on the desk
       of somebody who has left. */
    const owner = deal.ownerUserId && names.has(deal.ownerUserId) ? deal.ownerUserId : null;
    const task = await createTodo(q, {
      title: rule.taskTitle ?? "Follow up",
      dueOn,
      assigneeUserId: owner,
      contactId: deal.contactId,
      dealId: deal.id,
      automationId: rule.id,
    });
    return {
      outcome: "done",
      detail: `Added the task “${task.title}” for ${owner ? names.get(owner) : "nobody yet"}, due ${dueOn}`,
      deal,
    };
  }

  const target = rule.targetStage!;
  if (deal.stage === target) {
    return { outcome: "skipped", detail: `Already in ${stageLabel(target)}`, deal };
  }
  const from = deal.stage;
  const moved = await moveStage(q, deal.id, target, { chain });
  if (!moved) throw new AutomationProblem("That deal no longer exists.");

  await logActivity(q, {
    entityType: "deal",
    entityId: deal.id,
    kind: target === "won" && !deal.wonAt ? "won" : "stage_change",
    title: `Moved to ${target}`,
    detail: `from ${from}. ${signature}`,
    amountCents: target === "won" ? moved.valueCents : undefined,
    actorUserId: null,
  });
  /* Re-read: a rule further down the chain may have acted on it too. */
  return {
    outcome: "done",
    detail: `Moved from ${stageLabel(from)} to ${stageLabel(target)}`,
    deal: (await getDeal(q, deal.id)) ?? moved,
  };
}

listenForDealEvents(runAutomations);
