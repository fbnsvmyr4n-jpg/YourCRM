import type { TenantQuery } from "../tenant";
import {
  REPLY_HOURS,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from "../ticket-rules";

/**
 * Tickets as rows. A ticket is an Inbox thread somebody is responsible for.
 *
 * Every statement filters `sub_account_id` itself; row-level security enforces
 * the same underneath, and a trigger refuses an assignee from outside the
 * workspace or a thread with no messages in it.
 */

type Row = {
  id: string;
  thread_id: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignee_user_id: string | null;
  awaiting_since: Date | null;
  resolved_at: Date | null;
  created_at: Date;
};

const COLUMNS = `id, thread_id, status, priority, assignee_user_id, awaiting_since, resolved_at, created_at`;

const toTicket = (r: Row): Ticket => ({
  id: r.id,
  threadId: r.thread_id,
  status: r.status,
  priority: r.priority,
  assigneeUserId: r.assignee_user_id,
  awaitingSince: r.awaiting_since ? r.awaiting_since.toISOString() : null,
  resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  createdAt: r.created_at.toISOString(),
});

const refused = (err: unknown) => (err as { code?: string }).code === "23514";

export async function listTickets(q: TenantQuery): Promise<Ticket[]> {
  const rows = await q.rows<Row>(`SELECT ${COLUMNS} FROM tickets WHERE sub_account_id = $1 ORDER BY created_at DESC, id`, [
    q.ctx.subAccountId,
  ]);
  return rows.map(toTicket);
}

export async function getTicket(q: TenantQuery, id: string): Promise<Ticket | null> {
  const row = await q.one<Row>(`SELECT ${COLUMNS} FROM tickets WHERE sub_account_id = $1 AND id = $2`, [
    q.ctx.subAccountId,
    id,
  ]);
  return row ? toTicket(row) : null;
}

/**
 * Start tracking a conversation. Doing it twice returns the ticket it already
 * is rather than an error — two people pressing the button agree.
 *
 * Whether a reply is owed is read from the thread: if the customer spoke last,
 * the clock starts from their message; if we did, the ticket starts out
 * waiting on them.
 */
export async function openTicket(
  q: TenantQuery,
  threadId: string,
  opts: { priority?: TicketPriority; assigneeUserId?: string | null } = {}
): Promise<{ ticket: Ticket; created: boolean } | { error: string }> {
  /*
     The clock starts at the EARLIEST unanswered message, not the latest one.

     This read used to take the thread's last message and start from that. A
     customer who wrote on Monday and chased on Thursday, with nobody answering
     either, then got a ticket that said "Reply within 24h" — so the person
     ignored longest in the whole workspace sorted below work that arrived this
     morning, and the bell did not count them at all. Found by opening a ticket
     on a thread with two unanswered messages, which nothing had ever done.

     `recordOnTicket` below has always used the earliest unanswered message.
     This is the same definition, asked of the thread as it already stands.
  */
  const found = await q.one<{ any_message: boolean; owed_since: Date | null }>(
    `WITH msg AS (
       SELECT direction, sent_at FROM messages
        WHERE sub_account_id = $1 AND thread_id = $2 AND deleted_at IS NULL
     )
     SELECT EXISTS (SELECT 1 FROM msg) AS any_message,
            (SELECT min(sent_at) FROM msg
              WHERE direction = 'received'
                AND sent_at > COALESCE(
                      (SELECT max(sent_at) FROM msg WHERE direction = 'sent'),
                      '-infinity'::timestamptz)) AS owed_since`,
    [q.ctx.subAccountId, threadId]
  );
  if (!found?.any_message) return { error: "That conversation no longer exists." };

  const owed = found.owed_since !== null;
  let row: Row | null;
  try {
    row = await q.attempt(() =>
      q.one<Row>(
        `INSERT INTO tickets (id, sub_account_id, thread_id, status, priority, assignee_user_id, awaiting_since, opened_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (sub_account_id, thread_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          `tk_${crypto.randomUUID().replace(/-/g, "")}`,
          q.ctx.subAccountId,
          threadId,
          owed ? "open" : "waiting",
          opts.priority ?? "normal",
          opts.assigneeUserId ?? null,
          found.owed_since,
          q.ctx.userId || null,
        ]
      )
    );
  } catch (err) {
    if (refused(err)) return { error: "That person cannot be given tickets in this workspace." };
    throw err;
  }
  if (row) return { ticket: toTicket(row), created: true };

  const existing = await q.one<Row>(`SELECT ${COLUMNS} FROM tickets WHERE sub_account_id = $1 AND thread_id = $2`, [
    q.ctx.subAccountId,
    threadId,
  ]);
  return existing ? { ticket: toTicket(existing), created: false } : { error: "That conversation no longer exists." };
}

/**
 * Change status, priority or owner.
 *
 * Resolving stops the clock and stamps when; marking it waiting says nothing is
 * owed; reopening clears the resolution but does not invent a customer message
 * to start a clock from.
 */
export async function updateTicket(
  q: TenantQuery,
  id: string,
  patch: { status?: TicketStatus; priority?: TicketPriority; assigneeUserId?: string | null }
): Promise<{ ticket: Ticket } | { error: string }> {
  const sets: string[] = [];
  const params: unknown[] = [q.ctx.subAccountId, id];
  const param = (v: unknown) => {
    params.push(v);
    const next = params.length;
    return `$${next}`;
  };

  if (patch.status === "resolved") {
    sets.push(
      `status = 'resolved'`,
      `resolved_at = CASE WHEN status = 'resolved' THEN resolved_at ELSE clock_timestamp() END`,
      `awaiting_since = NULL`
    );
  } else if (patch.status === "waiting") {
    sets.push(`status = 'waiting'`, `resolved_at = NULL`, `awaiting_since = NULL`);
  } else if (patch.status === "open") {
    sets.push(`status = 'open'`, `resolved_at = NULL`);
  }
  if (patch.priority) sets.push(`priority = ${param(patch.priority)}`);
  if (patch.assigneeUserId !== undefined) sets.push(`assignee_user_id = ${param(patch.assigneeUserId)}`);
  if (sets.length === 0) {
    const t = await getTicket(q, id);
    return t ? { ticket: t } : { error: "That ticket no longer exists." };
  }

  try {
    const row = await q.attempt(() =>
      q.one<Row>(
        `UPDATE tickets SET ${sets.join(", ")} WHERE sub_account_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
        params
      )
    );
    return row ? { ticket: toTicket(row) } : { error: "That ticket no longer exists." };
  } catch (err) {
    if (refused(err)) return { error: "That person cannot be given tickets in this workspace." };
    throw err;
  }
}

/**
 * Keep a ticket's clock true when a message is recorded on its thread.
 *
 * Called by the message writer in the same transaction, so a reply and the
 * ticket it answers cannot disagree.
 *
 *  - Theirs: the ticket is open again and a reply is owed from the EARLIEST
 *    unanswered message. A message written before the ticket was resolved does
 *    not reopen it — logging yesterday's WhatsApp is not a new request.
 *  - Ours: nothing is owed any more, unless our message predates what they
 *    said; an open ticket moves to waiting on them.
 */
export async function recordOnTicket(
  q: TenantQuery,
  threadId: string,
  direction: "sent" | "received",
  sentAt: string
): Promise<void> {
  if (direction === "received") {
    /*
       A message from them that NOTHING OF OURS ANSWERS reopens the ticket.

       This used to refuse to reopen when the message was sent before the ticket
       was resolved — the intent being that logging yesterday's WhatsApp is not
       a new request. The intent was right and the test was wrong, in a way that
       cost the customer rather than us: a reply that arrives at 09:59 and is
       recorded at 10:01, either side of somebody pressing Resolve at 10:00, was
       silently ignored. No clock, no bell, nobody owing anything — for a
       customer who is sitting there waiting.

       Note what cannot happen: a message that was ALREADY in the inbox when
       somebody resolved the ticket does not pass through here at all, because
       this runs when a message is first recorded. So "it was covered by the
       resolution" is not a case this code can see; every message reaching it is
       news. What is left is whether anybody has answered it, which is the same
       question the clock itself asks.
    */
    await q.rows(
      `UPDATE tickets t
          SET status = 'open',
              resolved_at = NULL,
              awaiting_since = LEAST(COALESCE(awaiting_since, $3::timestamptz), $3::timestamptz)
        WHERE t.sub_account_id = $1 AND t.thread_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.sub_account_id = t.sub_account_id AND m.thread_id = t.thread_id
               AND m.deleted_at IS NULL AND m.direction = 'sent'
               AND m.sent_at >= $3::timestamptz)`,
      [q.ctx.subAccountId, threadId, sentAt]
    );
    return;
  }
  await q.rows(
    `UPDATE tickets
        SET awaiting_since = CASE WHEN awaiting_since > $3::timestamptz THEN awaiting_since ELSE NULL END,
            status = CASE WHEN status = 'open' AND NOT COALESCE(awaiting_since > $3::timestamptz, FALSE)
                          THEN 'waiting' ELSE status END
      WHERE sub_account_id = $1 AND thread_id = $2 AND status <> 'resolved'`,
    [q.ctx.subAccountId, threadId, sentAt]
  );
}

/**
 * Overdue replies somebody should be told about: theirs, and nobody's.
 * The hours come from `REPLY_HOURS`, so the bell and the queue share a clock.
 *
 * It counts only tickets the QUEUE CAN SHOW. The queue draws one row per ticket
 * from that conversation's latest message and skips binned mail, so a ticket
 * whose whole thread is in the bin was counted here and reachable nowhere — a
 * badge saying a customer is waiting, with no screen that can clear it. A badge
 * that cannot be cleared is worse than no badge: it teaches people to ignore
 * the one that matters.
 */
export async function overdueTickets(q: TenantQuery, userId: string): Promise<{ mine: number; unassigned: number }> {
  const row = await q.one<{ mine: string; unassigned: string }>(
    `SELECT count(*) FILTER (WHERE assignee_user_id = $2)::text AS mine,
            count(*) FILTER (WHERE assignee_user_id IS NULL)::text AS unassigned
       FROM tickets t
      WHERE sub_account_id = $1 AND status <> 'resolved' AND awaiting_since IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM messages m
           WHERE m.sub_account_id = t.sub_account_id AND m.thread_id = t.thread_id
             AND m.deleted_at IS NULL)
        AND awaiting_since + make_interval(hours => CASE priority
              WHEN 'urgent' THEN $3::int WHEN 'high' THEN $4::int
              WHEN 'normal' THEN $5::int ELSE $6::int END) < now()`,
    [q.ctx.subAccountId, userId, REPLY_HOURS.urgent, REPLY_HOURS.high, REPLY_HOURS.normal, REPLY_HOURS.low]
  );
  return { mine: Number(row?.mine ?? 0), unassigned: Number(row?.unassigned ?? 0) };
}
