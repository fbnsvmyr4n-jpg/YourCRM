import type { TenantQuery } from "../tenant";
import { canAccessCrm } from "../permissions";
import type { Source, Stage } from "./deals";
import type { ActionKind, Automation, AutomationDraft, EventKind } from "../automation-rules";

/**
 * Automations and what they did, as rows.
 *
 * Tenant-scoped like every CRM table: each statement filters `sub_account_id`
 * itself and row-level security enforces the same underneath.
 */

type Row = {
  id: string;
  event_kind: EventKind;
  when_source: Source | null;
  when_stage: Stage | null;
  action_kind: ActionKind;
  assignee_ids: string[] | null;
  target_stage: Stage | null;
  task_title: string | null;
  task_due_days: number | null;
  rotation_position: number;
  enabled: boolean;
  created_at: Date;
};

const COLUMNS = `id, event_kind, when_source, when_stage, action_kind, assignee_ids, target_stage,
                 task_title, task_due_days, rotation_position, enabled, created_at`;

const toAutomation = (r: Row): Automation => ({
  id: r.id,
  eventKind: r.event_kind,
  whenSource: r.when_source,
  whenStage: r.when_stage,
  actionKind: r.action_kind,
  assigneeIds: r.assignee_ids ?? [],
  targetStage: r.target_stage,
  taskTitle: r.task_title,
  taskDueDays: r.task_due_days,
  rotationPosition: r.rotation_position,
  enabled: r.enabled,
  createdAt: r.created_at.toISOString(),
});

export async function listAutomations(q: TenantQuery): Promise<Automation[]> {
  const rows = await q.rows<Row>(
    `SELECT ${COLUMNS} FROM automations WHERE sub_account_id = $1 ORDER BY created_at, id`,
    [q.ctx.subAccountId]
  );
  return rows.map(toAutomation);
}

/**
 * The switched-on rules for one kind of event, LOCKED until the transaction
 * ends.
 *
 * The lock is what makes a rotation fair under concurrency. Two leads arriving
 * at the same moment would otherwise both read "Sam's turn" and both go to Sam;
 * with it, the second waits for the first to move the position on. Ordered by
 * age, so rules apply in the order they were made — the one a person added last
 * has the last word, which is the order they would expect.
 */
export async function automationsFor(q: TenantQuery, eventKind: EventKind): Promise<Automation[]> {
  const rows = await q.rows<Row>(
    `SELECT ${COLUMNS} FROM automations
      WHERE sub_account_id = $1 AND event_kind = $2 AND enabled
      ORDER BY created_at, id
      FOR UPDATE`,
    [q.ctx.subAccountId, eventKind]
  );
  return rows.map(toAutomation);
}

export async function createAutomation(
  q: TenantQuery,
  id: string,
  draft: AutomationDraft
): Promise<Automation> {
  const row = await q.one<Row>(
    `INSERT INTO automations
       (id, sub_account_id, event_kind, when_source, when_stage, action_kind, assignee_ids,
        target_stage, task_title, task_due_days, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11)
     RETURNING ${COLUMNS}`,
    [
      id,
      q.ctx.subAccountId,
      draft.eventKind,
      draft.whenSource,
      draft.whenStage,
      draft.actionKind,
      draft.assigneeIds,
      draft.targetStage,
      draft.taskTitle,
      draft.taskDueDays,
      q.ctx.userId || null,
    ]
  );
  if (!row) throw new Error("The automation was not saved.");
  return toAutomation(row);
}

/**
 * On or off. `updated_at` moves, which is what lets the notification feed stop
 * reporting failures from before somebody looked at the rule.
 */
export async function setAutomationEnabled(q: TenantQuery, id: string, enabled: boolean): Promise<boolean> {
  const rows = await q.rows<{ id: string }>(
    `UPDATE automations SET enabled = $3, updated_at = now()
      WHERE sub_account_id = $1 AND id = $2
      RETURNING id`,
    [q.ctx.subAccountId, id, enabled]
  );
  return rows.length > 0;
}

/** Gone for good — its history stays, detached, so what it did is still explained. */
export async function deleteAutomation(q: TenantQuery, id: string): Promise<boolean> {
  const rows = await q.rows<{ id: string }>(
    `DELETE FROM automations WHERE sub_account_id = $1 AND id = $2 RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return rows.length > 0;
}

export async function advanceRotation(q: TenantQuery, id: string, position: number): Promise<void> {
  await q.rows(
    `UPDATE automations SET rotation_position = $3
      WHERE sub_account_id = $1 AND id = $2`,
    [q.ctx.subAccountId, id, position]
  );
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

export type RunOutcome = "done" | "skipped" | "failed";

export async function recordRun(
  q: TenantQuery,
  run: { automationId: string; dealId: string | null; outcome: RunOutcome; detail: string }
): Promise<void> {
  await q.rows(
    `INSERT INTO automation_runs (id, sub_account_id, automation_id, deal_id, outcome, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      `ar_${crypto.randomUUID().replace(/-/g, "")}`,
      q.ctx.subAccountId,
      run.automationId,
      run.dealId,
      run.outcome,
      run.detail.slice(0, 300),
    ]
  );
}

export type AutomationRun = {
  id: string;
  automationId: string | null;
  dealId: string | null;
  /** The deal as it is NOW; null once it has been deleted. */
  dealTitle: string | null;
  outcome: RunOutcome;
  detail: string;
  at: string;
};

export async function listRuns(q: TenantQuery, limit = 8): Promise<AutomationRun[]> {
  const rows = await q.rows<{
    id: string;
    automation_id: string | null;
    deal_id: string | null;
    deal_title: string | null;
    outcome: RunOutcome;
    detail: string;
    at: Date;
  }>(
    `SELECT r.id, r.automation_id, r.deal_id, d.title AS deal_title, r.outcome, r.detail, r.at
       FROM automation_runs r
       LEFT JOIN deals d
         ON d.id = r.deal_id AND d.sub_account_id = r.sub_account_id AND d.deleted_at IS NULL
      WHERE r.sub_account_id = $1
      ORDER BY r.at DESC, r.id DESC
      LIMIT $2`,
    [q.ctx.subAccountId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    automationId: r.automation_id,
    dealId: r.deal_id,
    dealTitle: r.deal_title,
    outcome: r.outcome,
    detail: r.detail,
    at: r.at.toISOString(),
  }));
}

/**
 * Rules that are failing NOW, for the notification feed.
 *
 * A state, not a log: a failure stops counting once the rule has since worked,
 * once somebody has switched it off or back on (they have looked at it), or
 * after a week. A bell that keeps ringing about something already fixed is a
 * bell people learn to ignore.
 */
export async function failingAutomations(
  q: TenantQuery
): Promise<{ count: number; latest: string | null }> {
  const rows = await q.rows<{ automation_id: string; detail: string }>(
    `SELECT DISTINCT ON (r.automation_id) r.automation_id, r.detail
       FROM automation_runs r
       JOIN automations a
         ON a.id = r.automation_id AND a.sub_account_id = r.sub_account_id
      WHERE r.sub_account_id = $1
        AND r.outcome = 'failed'
        AND a.enabled
        AND r.at > a.updated_at
        AND r.at > now() - interval '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM automation_runs later
           WHERE later.sub_account_id = r.sub_account_id
             AND later.automation_id = r.automation_id
             AND later.outcome = 'done'
             AND later.at > r.at
        )
      ORDER BY r.automation_id, r.at DESC`,
    [q.ctx.subAccountId]
  );
  return { count: rows.length, latest: rows[0]?.detail ?? null };
}

/* ------------------------------------------------------------------ */
/* Who can be given work                                               */
/* ------------------------------------------------------------------ */

/**
 * The people a rule may hand a deal to, in this workspace.
 *
 * The same test the database's owner trigger applies — same agency, not
 * deleted, and either agency-wide or pinned to THIS workspace — plus the one
 * the trigger cannot know about: they must be allowed to see customer records.
 * Giving a lead to the IT administrator would be a lead nobody can open.
 */
export async function assignableTeam(q: TenantQuery): Promise<{ id: string; name: string }[]> {
  const rows = await q.rows<{ id: string; name: string; role: string }>(
    `SELECT u.id, u.name, u.role FROM users u
      WHERE u.agency_id = $1
        AND u.deleted_at IS NULL
        AND (u.sub_account_id IS NULL OR u.sub_account_id = $2)
      ORDER BY lower(u.name), u.id`,
    [q.ctx.agencyId, q.ctx.subAccountId]
  );
  return rows.filter((r) => canAccessCrm(r.role)).map((r) => ({ id: r.id, name: r.name }));
}
