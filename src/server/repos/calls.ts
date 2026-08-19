import type { TenantQuery } from "../tenant";

/**
 * Calls handled by the voice agent.
 *
 * Scope note, because the old repository got this wrong: `processCall` used to
 * live here and created a lead and a meeting as a side effect of reading a
 * call. That is orchestration across three entities, and the project rule is
 * that repositories stay leaves — anything touching several of them belongs in
 * a layer above. So this module records calls and links them; turning a call
 * into a contact and a meeting is the caller's job.
 *
 * `created_deal_id` is a link, not an instruction: it records that a deal came
 * out of this call, so the connection survives independently of whoever made it.
 */

export const CALLER_ROLES = ["caller", "agent"] as const;
export type CallerRole = (typeof CALLER_ROLES)[number];

export type TranscriptTurn = {
  role: CallerRole;
  text: string;
};

export type CallRecord = {
  id: string;
  contactId: string | null;
  createdDealId: string | null;
  callerName: string;
  phone: string | null;
  receivedAt: string;
  durationSec: number;
  outcome: string | null;
  summary: string | null;
  transcript: TranscriptTurn[];
  /** What the caller wanted to discuss. */
  topic: string | null;
  /** When they asked to meet — an instant, resolved at capture. */
  requestedAt: string | null;
  /** The meeting this call produced, if it produced one. */
  createdMeetingId: string | null;
  deletedAt: string | null;
};

export type NewCall = {
  callerName?: string;
  phone?: string | null;
  receivedAt?: string | Date;
  durationSec?: number;
  outcome?: string | null;
  summary?: string | null;
  transcript?: TranscriptTurn[];
  contactId?: string | null;
  topic?: string | null;
  requestedAt?: string | Date | null;
};

type Row = {
  id: string;
  contact_id: string | null;
  created_deal_id: string | null;
  caller_name: string;
  phone: string | null;
  received_at: Date;
  duration_sec: number;
  outcome: string | null;
  summary: string | null;
  transcript: TranscriptTurn[];
  topic: string | null;
  requested_at: Date | null;
  created_meeting_id: string | null;
  deleted_at: Date | null;
};

const SELECT = `
  SELECT c.id, c.contact_id, c.created_deal_id, c.caller_name, c.phone,
         c.received_at, c.duration_sec, c.outcome, c.summary, c.transcript,
         c.topic, c.requested_at, c.created_meeting_id, c.deleted_at
  FROM calls c
  WHERE c.deleted_at IS NULL AND c.sub_account_id = $1`;

function toRecord(r: Row): CallRecord {
  return {
    id: r.id,
    contactId: r.contact_id,
    createdDealId: r.created_deal_id,
    callerName: r.caller_name,
    phone: r.phone,
    receivedAt: r.received_at.toISOString(),
    durationSec: r.duration_sec,
    outcome: r.outcome,
    summary: r.summary,
    transcript: r.transcript ?? [],
    topic: r.topic,
    requestedAt: r.requested_at ? r.requested_at.toISOString() : null,
    createdMeetingId: r.created_meeting_id,
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  };
}

function checkDuration(sec: number): number {
  // A negative call length is not a rounding problem, it is a broken clock
  // somewhere upstream, and averaging it silently drags every statistic down.
  if (!Number.isInteger(sec) || sec < 0) throw new Error("Call duration must be whole seconds.");
  if (sec > 24 * 3600) throw new Error("Call duration is out of range.");
  return sec;
}

function checkTranscript(turns: TranscriptTurn[]): TranscriptTurn[] {
  for (const t of turns) {
    if (!CALLER_ROLES.includes(t.role)) throw new Error(`Unknown transcript role: ${t.role}`);
  }
  return turns;
}

export async function listCalls(q: TenantQuery, limit = 50): Promise<CallRecord[]> {
  const rows = await q.rows<Row>(`${SELECT} ORDER BY c.received_at DESC, c.id DESC LIMIT $2`, [
    q.ctx.subAccountId,
    limit,
  ]);
  return rows.map(toRecord);
}

export async function getCall(q: TenantQuery, id: string): Promise<CallRecord | null> {
  const row = await q.one<Row>(`${SELECT} AND c.id = $2`, [q.ctx.subAccountId, id]);
  return row ? toRecord(row) : null;
}

export async function listCallsForContact(q: TenantQuery, contactId: string): Promise<CallRecord[]> {
  const rows = await q.rows<Row>(`${SELECT} AND c.contact_id = $2 ORDER BY c.received_at DESC`, [
    q.ctx.subAccountId,
    contactId,
  ]);
  return rows.map(toRecord);
}

export async function logCall(q: TenantQuery, input: NewCall = {}): Promise<CallRecord> {
  const received = input.receivedAt
    ? input.receivedAt instanceof Date
      ? input.receivedAt
      : new Date(input.receivedAt)
    : null;
  if (received && Number.isNaN(received.getTime())) {
    throw new Error("Call time is not a valid date.");
  }

  const row = await q.one<Row>(
    `WITH inserted AS (
       INSERT INTO calls
         (id, sub_account_id, contact_id, caller_name, phone, received_at,
          duration_sec, outcome, summary, transcript, topic, requested_at)
       VALUES ($2, $1, $3, $4, $5, COALESCE($6, now()), $7, $8, $9, $10::jsonb, $11, $12)
       RETURNING *
     )
     ${SELECT.replace("FROM calls c", "FROM inserted c")}`,
    [
      q.ctx.subAccountId,
      `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      input.contactId ?? null,
      input.callerName?.trim() ?? "",
      input.phone?.trim() || null,
      received,
      checkDuration(input.durationSec ?? 0),
      input.outcome?.trim() || null,
      input.summary?.trim() || null,
      JSON.stringify(checkTranscript(input.transcript ?? [])),
      input.topic?.trim() || null,
      input.requestedAt ? new Date(input.requestedAt) : null,
    ]
  );
  if (!row) throw new Error("Call was not logged.");
  return toRecord(row);
}

export async function updateCall(
  q: TenantQuery,
  id: string,
  patch: { summary?: string | null; outcome?: string | null; durationSec?: number; callerName?: string }
): Promise<CallRecord | null> {
  if (patch.durationSec !== undefined) checkDuration(patch.durationSec);
  const row = await q.one<Row>(
    `WITH updated AS (
       UPDATE calls SET
         summary      = CASE WHEN $3::boolean THEN $4 ELSE summary END,
         outcome      = CASE WHEN $5::boolean THEN $6 ELSE outcome END,
         duration_sec = COALESCE($7, duration_sec),
         caller_name  = COALESCE($8, caller_name)
       WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
       RETURNING *
     )
     ${SELECT.replace("FROM calls c", "FROM updated c")}`,
    [
      q.ctx.subAccountId,
      id,
      patch.summary !== undefined,
      patch.summary?.trim() ?? null,
      patch.outcome !== undefined,
      patch.outcome?.trim() ?? null,
      patch.durationSec ?? null,
      patch.callerName?.trim() ?? null,
    ]
  );
  return row ? toRecord(row) : null;
}

/** Append to the transcript in SQL, so a live call cannot lose turns to a race. */
export async function appendTranscript(
  q: TenantQuery,
  id: string,
  turns: TranscriptTurn[]
): Promise<CallRecord | null> {
  const cleaned = checkTranscript(turns).filter((t) => t.text.trim());
  if (cleaned.length === 0) return getCall(q, id);

  // Same reasoning as pain points on a deal: reading the array into JavaScript
  // and writing it back loses whatever arrived in between, and a call in
  // progress is precisely where turns arrive in between.
  const row = await q.one<Row>(
    `WITH updated AS (
       UPDATE calls SET transcript = transcript || $3::jsonb
       WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
       RETURNING *
     )
     ${SELECT.replace("FROM calls c", "FROM updated c")}`,
    [q.ctx.subAccountId, id, JSON.stringify(cleaned)]
  );
  return row ? toRecord(row) : null;
}

/**
 * Link a call to the contact and the deal it produced.
 *
 * Passing null unlinks. Both are separate from `updateCall` because a link is a
 * claim about how two records relate, not a field somebody edits in a form.
 */
export async function linkCall(
  q: TenantQuery,
  id: string,
  links: { contactId?: string | null; createdDealId?: string | null; createdMeetingId?: string | null }
): Promise<CallRecord | null> {
  const row = await q.one<Row>(
    `WITH updated AS (
       UPDATE calls SET
         contact_id      = CASE WHEN $3::boolean THEN $4 ELSE contact_id END,
         created_deal_id = CASE WHEN $5::boolean THEN $6 ELSE created_deal_id END,
         created_meeting_id = CASE WHEN $7::boolean THEN $8 ELSE created_meeting_id END
       WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
       RETURNING *
     )
     ${SELECT.replace("FROM calls c", "FROM updated c")}`,
    [
      q.ctx.subAccountId,
      id,
      links.contactId !== undefined,
      links.contactId ?? null,
      links.createdDealId !== undefined,
      links.createdDealId ?? null,
      links.createdMeetingId !== undefined,
      links.createdMeetingId ?? null,
    ]
  );
  return row ? toRecord(row) : null;
}

export async function deleteCall(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE calls SET deleted_at = now()
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return row !== null;
}

export async function restoreCall(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE calls SET deleted_at = NULL
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NOT NULL RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return row !== null;
}
