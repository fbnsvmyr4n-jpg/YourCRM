import type { TenantQuery } from "../tenant";

/**
 * Meetings.
 *
 * The audit rated this entity's outcome model as the one the deal pipeline
 * should have copied, so the model is ported deliberately rather than
 * redesigned. Its two good ideas:
 *
 *  - An outcome is *recorded*, not inferred from the clock. A meeting in the
 *    past is not automatically "showed"; somebody has to say what happened.
 *  - Every rate is computed out of meetings whose outcome is known. Meetings
 *    still marked `scheduled` are reported separately as pending rather than
 *    silently counted as failures — rating a team on meetings that have not
 *    happened yet is how a show-rate ends up meaningless.
 *
 * Two things changed in the port. Outcome values now match the schema's CHECK
 * constraint (`no_show`, not `"no-show"` — the old repo and the schema had
 * already drifted). And the statistics are one aggregate query instead of
 * loading every meeting into JavaScript and filtering it six times.
 */

export const OUTCOMES = ["scheduled", "no_show", "showed", "advanced", "won", "lost"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const KINDS = ["online", "in_person"] as const;

/**
 * The stored kind for a label the UI shows.
 *
 * The database stores `online` / `in_person`; every screen says "Online" and
 * "In-Person". Both meeting forms posted the LABEL into a field validated
 * against the stored values, so `pick` returned null and the action bailed —
 * booking a meeting through the scheduler silently created nothing, and
 * rescheduling failed with "Check the name, date and format." on a form where
 * the name, the date and the format were all plainly fine.
 *
 * Translating here, next to the values themselves, so a caller cannot post one
 * vocabulary at a field that speaks the other. Stored values are still accepted
 * unchanged, which is what lets the same field take either.
 */
export function kindFromLabel(value: unknown): (typeof KINDS)[number] | null {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v === "online") return "online";
  if (v === "in-person" || v === "in_person" || v === "in person") return "in_person";
  return null;
}
export type Kind = (typeof KINDS)[number];

/** Outcomes that mean the meeting happened, whatever came of it afterwards. */
export const ATTENDED_OUTCOMES = ["showed", "advanced", "won", "lost"] as const;

export type MeetingRecord = {
  id: string;
  contactId: string | null;
  dealId: string | null;
  ownerUserId: string | null;
  topic: string;
  scheduledAt: string;
  durationMin: number;
  kind: Kind;
  joinUrl: string | null;
  notes: string | null;
  outcome: Outcome;
  lossReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewMeeting = {
  topic: string;
  scheduledAt: string | Date;
  durationMin?: number;
  kind?: Kind;
  contactId?: string | null;
  dealId?: string | null;
  ownerUserId?: string | null;
  joinUrl?: string | null;
  notes?: string | null;
};

type Row = {
  id: string;
  contact_id: string | null;
  deal_id: string | null;
  owner_user_id: string | null;
  topic: string;
  scheduled_at: Date;
  duration_min: number;
  kind: Kind;
  join_url: string | null;
  notes: string | null;
  outcome: Outcome;
  loss_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

const SELECT = `
  SELECT m.id, m.contact_id, m.deal_id, m.owner_user_id, m.topic, m.scheduled_at,
         m.duration_min, m.kind, m.join_url, m.notes, m.outcome, m.loss_reason,
         m.created_at, m.updated_at
  FROM meetings m
  WHERE m.deleted_at IS NULL AND m.sub_account_id = $1`;

function toRecord(r: Row): MeetingRecord {
  return {
    id: r.id,
    contactId: r.contact_id,
    dealId: r.deal_id,
    ownerUserId: r.owner_user_id,
    topic: r.topic,
    scheduledAt: r.scheduled_at.toISOString(),
    durationMin: r.duration_min,
    kind: r.kind,
    joinUrl: r.join_url,
    notes: r.notes,
    outcome: r.outcome,
    lossReason: r.loss_reason,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function newId(topic: string): string {
  const base = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  return `${base || "meeting"}-${Math.random().toString(36).slice(2, 8)}`;
}

function checkWhen(when: string | Date): Date {
  const d = when instanceof Date ? when : new Date(when);
  // An invalid Date passed to Postgres becomes a confusing driver error far
  // from the cause; caught here it names the actual problem.
  if (Number.isNaN(d.getTime())) throw new Error("Meeting time is not a valid date.");
  return d;
}

function checkDuration(min: number): number {
  if (!Number.isInteger(min) || min <= 0) throw new Error("Meeting duration must be whole minutes.");
  if (min > 24 * 60) throw new Error("Meeting duration is out of range.");
  return min;
}

export async function listMeetings(q: TenantQuery): Promise<MeetingRecord[]> {
  const rows = await q.rows<Row>(`${SELECT} ORDER BY m.scheduled_at DESC, m.id`, [
    q.ctx.subAccountId,
  ]);
  return rows.map(toRecord);
}

export async function getMeeting(q: TenantQuery, id: string): Promise<MeetingRecord | null> {
  const row = await q.one<Row>(`${SELECT} AND m.id = $2`, [q.ctx.subAccountId, id]);
  return row ? toRecord(row) : null;
}

/**
 * Meetings still ahead of us, soonest first.
 *
 * Bounded by the clock *and* by the outcome: a meeting somebody already marked
 * as a no-show should not reappear in "upcoming" merely because its start time
 * has not passed yet. `now()` is the database's clock, so the answer does not
 * depend on which server rendered the page.
 */
export async function listUpcoming(q: TenantQuery, limit = 50): Promise<MeetingRecord[]> {
  const rows = await q.rows<Row>(
    `${SELECT} AND m.scheduled_at >= now() AND m.outcome = 'scheduled'
     ORDER BY m.scheduled_at ASC, m.id LIMIT $2`,
    [q.ctx.subAccountId, limit]
  );
  return rows.map(toRecord);
}

export async function listBetween(
  q: TenantQuery,
  from: string | Date,
  to: string | Date
): Promise<MeetingRecord[]> {
  const rows = await q.rows<Row>(
    `${SELECT} AND m.scheduled_at >= $2 AND m.scheduled_at < $3
     ORDER BY m.scheduled_at ASC, m.id`,
    [q.ctx.subAccountId, checkWhen(from), checkWhen(to)]
  );
  return rows.map(toRecord);
}

export async function createMeeting(q: TenantQuery, input: NewMeeting): Promise<MeetingRecord> {
  const row = await q.one<Row>(
    `WITH inserted AS (
       INSERT INTO meetings
         (id, sub_account_id, contact_id, deal_id, owner_user_id, topic,
          scheduled_at, duration_min, kind, join_url, notes)
       VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *
     )
     ${SELECT.replace("FROM meetings m", "FROM inserted m")}`,
    [
      q.ctx.subAccountId,
      newId(input.topic),
      input.contactId ?? null,
      input.dealId ?? null,
      input.ownerUserId ?? null,
      input.topic.trim(),
      checkWhen(input.scheduledAt),
      checkDuration(input.durationMin ?? 30),
      input.kind ?? "online",
      input.joinUrl?.trim() || null,
      input.notes?.trim() || null,
    ]
  );
  if (!row) throw new Error("Meeting was not created.");
  return toRecord(row);
}

export async function updateMeeting(
  q: TenantQuery,
  id: string,
  patch: Partial<NewMeeting>
): Promise<MeetingRecord | null> {
  // Outcome is not settable here, for the same reason stage is not settable on
  // a deal: it carries a side effect on `loss_reason`. Use `recordOutcome`.
  const row = await q.one<Row>(
    `WITH updated AS (
       UPDATE meetings SET
         topic        = COALESCE($3, topic),
         scheduled_at = COALESCE($4, scheduled_at),
         duration_min = COALESCE($5, duration_min),
         kind         = COALESCE($6, kind),
         contact_id   = CASE WHEN $7::boolean  THEN $8  ELSE contact_id END,
         deal_id      = CASE WHEN $9::boolean  THEN $10 ELSE deal_id END,
         owner_user_id= CASE WHEN $11::boolean THEN $12 ELSE owner_user_id END,
         join_url     = CASE WHEN $13::boolean THEN $14 ELSE join_url END,
         notes        = CASE WHEN $15::boolean THEN $16 ELSE notes END,
         updated_at   = now()
       WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
       RETURNING *
     )
     ${SELECT.replace("FROM meetings m", "FROM updated m")}`,
    [
      q.ctx.subAccountId,
      id,
      patch.topic?.trim() ?? null,
      patch.scheduledAt ? checkWhen(patch.scheduledAt) : null,
      patch.durationMin !== undefined ? checkDuration(patch.durationMin) : null,
      patch.kind ?? null,
      patch.contactId !== undefined,
      patch.contactId ?? null,
      patch.dealId !== undefined,
      patch.dealId ?? null,
      patch.ownerUserId !== undefined,
      patch.ownerUserId ?? null,
      patch.joinUrl !== undefined,
      patch.joinUrl?.trim() ?? null,
      patch.notes !== undefined,
      patch.notes?.trim() ?? null,
    ]
  );
  return row ? toRecord(row) : null;
}

/**
 * Record what actually happened.
 *
 * A loss reason only exists while the outcome is `lost`, and is cleared
 * otherwise — the same rule the deal pipeline follows, so a meeting re-marked
 * as `showed` cannot keep a stale explanation of why it was lost.
 */
export async function recordOutcome(
  q: TenantQuery,
  id: string,
  outcome: Outcome,
  opts: { lossReason?: string | null } = {}
): Promise<MeetingRecord | null> {
  if (!OUTCOMES.includes(outcome)) throw new Error(`Unknown outcome: ${outcome}`);
  if (outcome === "lost" && !opts.lossReason?.trim()) {
    throw new Error("A lost meeting needs a reason.");
  }

  const row = await q.one<Row>(
    `WITH updated AS (
       UPDATE meetings SET
         outcome     = $3,
         loss_reason = CASE WHEN $3 = 'lost' THEN $4 ELSE NULL END,
         updated_at  = now()
       WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
       RETURNING *
     )
     ${SELECT.replace("FROM meetings m", "FROM updated m")}`,
    [q.ctx.subAccountId, id, outcome, opts.lossReason?.trim() ?? null]
  );
  return row ? toRecord(row) : null;
}

export async function deleteMeeting(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE meetings SET deleted_at = now(), updated_at = now()
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return row !== null;
}

export async function restoreMeeting(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE meetings SET deleted_at = NULL, updated_at = now()
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NOT NULL RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return row !== null;
}

export type MeetingStats = {
  total: number;
  /** Outcome not yet recorded. The honest caveat on every rate below. */
  pending: number;
  /** The denominator for every rate: meetings whose outcome is known. */
  recorded: number;
  noShow: number;
  attended: number;
  won: number;
  lost: number;
  /**
   * Null, never zero, when nothing has been recorded yet.
   *
   * "No data" and "0%" are different claims and the product rule is that an
   * invented number is never rendered. A rate with no recorded meetings behind
   * it reads as an em dash, which is why these are nullable at the source
   * rather than defaulted somewhere in a component.
   */
  showRate: number | null;
  winRate: number | null;
};

/**
 * Every figure on the Meetings page, as one aggregate.
 *
 * Counted in SQL rather than by pulling every meeting into memory and filtering
 * it once per statistic, which is what the JSONB version did.
 */
export async function meetingStats(q: TenantQuery): Promise<MeetingStats> {
  const row = await q.one<{
    total: string;
    pending: string;
    no_show: string;
    attended: string;
    won: string;
    lost: string;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE outcome = 'scheduled')::text AS pending,
            count(*) FILTER (WHERE outcome = 'no_show')::text   AS no_show,
            count(*) FILTER (WHERE outcome IN ('showed','advanced','won','lost'))::text AS attended,
            count(*) FILTER (WHERE outcome = 'won')::text  AS won,
            count(*) FILTER (WHERE outcome = 'lost')::text AS lost
     FROM meetings
     WHERE deleted_at IS NULL AND sub_account_id = $1`,
    [q.ctx.subAccountId]
  );

  const total = Number(row?.total ?? 0);
  const pending = Number(row?.pending ?? 0);
  const noShow = Number(row?.no_show ?? 0);
  const attended = Number(row?.attended ?? 0);
  const won = Number(row?.won ?? 0);
  const lost = Number(row?.lost ?? 0);
  const recorded = total - pending;

  return {
    total,
    pending,
    recorded,
    noShow,
    attended,
    won,
    lost,
    showRate: recorded > 0 ? Math.round((attended / recorded) * 100) : null,
    // Out of decided meetings only. Including still-open ones would make the
    // win rate fall every time a meeting is booked, which is the arithmetic
    // error the deal pipeline had.
    // Percentage, 0–100 — the unit every rate in the product uses.
    winRate: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null,
  };
}

/**
 * Assign, reassign or unassign the owner of this record.
 *
 * Separate from the general update for the same reason a stage change is: it
 * is a claim about who is responsible, not a form field, and it is the one
 * write the database refuses on grounds the caller cannot see from the row.
 *
 * A database trigger rejects an owner from another tenant — a plain foreign key
 * cannot express that, because the tenant is on this row and the agency is on
 * the user. The check runs there rather than only here so an import script or a
 * future endpoint cannot skip it. This turns its error into a readable one;
 * it does not replace it.
 *
 * `null` unassigns, which is always allowed.
 */
export async function assignOwner(
  q: TenantQuery,
  id: string,
  ownerUserId: string | null
): Promise<{ record?: MeetingRecord; error?: string }> {
  try {
    const row = await q.one<Row>(
      `WITH updated AS (
         UPDATE meetings SET owner_user_id = $3
         WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
         RETURNING *
       )
       ${SELECT.replace("FROM meetings m", "FROM updated m").replace("$1", "$1")}`,
      [q.ctx.subAccountId, id, ownerUserId]
    );
    return row ? { record: toRecord(row) } : { error: "That record no longer exists." };
  } catch (err) {
    if (String(err).includes("does not belong to sub-account")) {
      return { error: "That person is not a member of this account." };
    }
    throw err;
  }
}

/** Everything assigned to one person — or, with null, everything unassigned. */
export async function listByOwner(
  q: TenantQuery,
  ownerUserId: string | null
): Promise<MeetingRecord[]> {
  const rows = await q.rows<Row>(
    `${SELECT} AND m.owner_user_id IS NOT DISTINCT FROM $2`,
    [q.ctx.subAccountId, ownerUserId]
  );
  return rows.map(toRecord);
}

