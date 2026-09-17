import type { TenantQuery } from "../tenant";

/**
 * Reading the audit log. Nothing here writes — entries are written by
 * `withTenant` as a transaction commits, and the table refuses edits.
 */

export type AuditEvent = {
  id: number;
  at: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  detail: string | null;
};

/** How many one screen shows. Enough to answer "who changed this, this week". */
export const AUDIT_PAGE = 200;

export async function listAuditEvents(q: TenantQuery, limit = AUDIT_PAGE): Promise<AuditEvent[]> {
  const rows = await q.rows<{
    id: string;
    at: Date;
    actor_user_id: string | null;
    actor_name: string | null;
    action: string;
    entity: string;
    entity_id: string | null;
    detail: string | null;
  }>(
    `SELECT id::text AS id, at, actor_user_id, actor_name, action, entity, entity_id, detail
       FROM audit_events
      WHERE sub_account_id = $1
      ORDER BY at DESC, id DESC
      LIMIT $2`,
    [q.ctx.subAccountId, Math.min(Math.max(1, limit), 1000)]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    at: r.at.toISOString(),
    actorId: r.actor_user_id,
    actorName: r.actor_name,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    detail: r.detail,
  }));
}
