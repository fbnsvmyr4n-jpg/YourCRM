import type { TenantQuery } from "../tenant";

/**
 * The activity log.
 *
 * Append-only, and deliberately so: this is the record of what happened, and a
 * history that can be edited is not a history. It is the one table in the
 * schema with no `deleted_at`, which is why nothing here updates or removes a
 * row. When a contact is soft-deleted its activities stay — the events did
 * occur — they simply stop being reachable, because reads are always by entity.
 *
 * Erasure (a customer asking for their data to be destroyed) is a different
 * operation with different rules and is not in this module. Building it as a
 * casual `deleteActivity` would make the log quietly editable in exchange for a
 * feature nobody has asked for yet.
 *
 * The old repository was called by `deleteContact` to clear a contact's history
 * in a second lock after the fact. The new contacts repo does not do that, so
 * the ordering hazard is gone with it.
 */

/** The entities an activity can be about. Pinned to the schema's CHECK constraint. */
export const ENTITY_TYPES = ["contact", "deal", "meeting", "company"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Known activity kinds.
 *
 * There is no CHECK constraint behind this, on purpose: a new kind of event
 * should not require a database migration, and an unknown kind arriving from a
 * newer deployment must not fail a write mid-release. So the list is validated
 * here in the application, where rejecting is cheap and reversible, and the
 * column stays open text. That is a real trade-off rather than an oversight —
 * the enum is honest about being an application rule, not a database one.
 */
export const ACTIVITY_KINDS = [
  "created",
  "updated",
  "note",
  "email",
  "call",
  // Texting a contact is its own event: the Contacts screen offers it as a
  // separate button, and folding it into "call" would misreport what happened.
  "text",
  "meeting",
  "stage_change",
  "won",
  "lost",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type ActivityRecord = {
  id: string;
  actorUserId: string | null;
  entityType: EntityType;
  entityId: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  /** Integer cents, or null when the event is not about money. */
  amountCents: number | null;
  at: string;
};

export type NewActivity = {
  entityType: EntityType;
  entityId: string;
  kind: ActivityKind;
  title: string;
  detail?: string | null;
  amountCents?: number | null;
  actorUserId?: string | null;
  at?: string | Date;
};

type Row = {
  id: string;
  actor_user_id: string | null;
  entity_type: EntityType;
  entity_id: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  amount_cents: string | null;
  at: Date;
};

const SELECT = `
  SELECT a.id, a.actor_user_id, a.entity_type, a.entity_id, a.kind, a.title,
         a.detail, a.amount_cents, a.at
  FROM activities a
  WHERE a.sub_account_id = $1`;

function toRecord(r: Row): ActivityRecord {
  return {
    id: r.id,
    actorUserId: r.actor_user_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    // BIGINT arrives as a string. Null stays null rather than becoming 0 —
    // "this event had no amount" and "this event was worth nothing" are
    // different claims and only one of them is true.
    amountCents: r.amount_cents === null ? null : Number(r.amount_cents),
    at: r.at.toISOString(),
  };
}

export async function listActivity(q: TenantQuery, limit = 50): Promise<ActivityRecord[]> {
  const rows = await q.rows<Row>(`${SELECT} ORDER BY a.at DESC, a.id DESC LIMIT $2`, [
    q.ctx.subAccountId,
    limit,
  ]);
  return rows.map(toRecord);
}

/**
 * One entity's history, newest first.
 *
 * `entity_id` carries no foreign key, because an activity outlives the thing it
 * describes — the log would otherwise lose exactly the events that matter most
 * when a record is removed. The cost is that orphaned rows are possible; they
 * are simply never returned, since every read names an entity.
 */
export async function listForEntity(
  q: TenantQuery,
  entityType: EntityType,
  entityId: string
): Promise<ActivityRecord[]> {
  if (!ENTITY_TYPES.includes(entityType)) throw new Error(`Unknown entity type: ${entityType}`);
  const rows = await q.rows<Row>(
    `${SELECT} AND a.entity_type = $2 AND a.entity_id = $3 ORDER BY a.at DESC, a.id DESC`,
    [q.ctx.subAccountId, entityType, entityId]
  );
  return rows.map(toRecord);
}

export async function logActivity(q: TenantQuery, input: NewActivity): Promise<ActivityRecord> {
  if (!ENTITY_TYPES.includes(input.entityType)) {
    throw new Error(`Unknown entity type: ${input.entityType}`);
  }
  if (!ACTIVITY_KINDS.includes(input.kind)) {
    throw new Error(`Unknown activity kind: ${input.kind}`);
  }
  if (input.amountCents != null && !Number.isSafeInteger(input.amountCents)) {
    throw new Error("Activity amount must be whole cents.");
  }
  if (!input.title.trim()) {
    // A log line nobody can read is worse than no log line: it takes up space
    // in the timeline and says nothing.
    throw new Error("An activity needs a title.");
  }

  const at = input.at ? (input.at instanceof Date ? input.at : new Date(input.at)) : null;
  if (at && Number.isNaN(at.getTime())) throw new Error("Activity time is not a valid date.");

  const row = await q.one<Row>(
    `WITH inserted AS (
       INSERT INTO activities
         (id, sub_account_id, actor_user_id, entity_type, entity_id, kind, title,
          detail, amount_cents, at)
       VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()))
       RETURNING *
     )
     ${SELECT.replace("FROM activities a", "FROM inserted a")}`,
    [
      q.ctx.subAccountId,
      `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      input.actorUserId ?? null,
      input.entityType,
      input.entityId,
      input.kind,
      input.title.trim(),
      input.detail?.trim() || null,
      input.amountCents ?? null,
      at,
    ]
  );
  if (!row) throw new Error("Activity was not logged.");
  return toRecord(row);
}
