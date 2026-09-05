import { classifyMessage } from "../inbox-classify";
import type { MsgCategory } from "@/data/inbox";
import type { TenantQuery } from "../tenant";

/**
 * Inbox messages.
 *
 * One thing here differs from every other repository, and it is deliberate:
 * **trash is a view of soft-deleted rows, not a hidden state.** Elsewhere
 * `deleted_at` means "gone from every read". Here the user expects to open the
 * bin and see what is in it, so the deleted predicate varies by folder instead
 * of being applied once. That is why the statements below are not built from a
 * single shared WHERE clause the way the others are.
 *
 * The second carried-over decision is that `category` is DERIVED at read time
 * unless somebody has overridden it. The stored column holds only a human's
 * explicit choice; a NULL means "ask the classifier". So improving the rules
 * improves old mail too, rather than only what arrives next — which is the
 * project rule about storing the fact and deriving the label, applied to a
 * label that is genuinely a guess.
 */

export const FOLDERS = ["inbox", "unread", "sent", "trash"] as const;
export type Folder = (typeof FOLDERS)[number];

export const DIRECTIONS = ["received", "sent"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * How a message reached you. Mirrors the CHECK on `messages.channel`, and the
 * pair is pinned together by a test — an enum with two sources of truth is the
 * drift this project's rules exist to prevent.
 */
export const CHANNELS = ["email", "whatsapp", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];

export type MessageRecord = {
  id: string;
  contactId: string | null;
  /**
   * The conversation this belongs to.
   *
   * Every message has one, including the first in a chain — a thread of one is
   * still a thread, and making it nullable would mean every reader handling
   * "no thread" as a special case forever.
   */
  threadId: string;
  /** The project this conversation is filed against, once somebody files it. */
  dealId: string | null;
  /**
   * The transport it arrived on — not where the contact originally came from.
   *
   * The badge in the list used to show the sender's ACQUISITION source, so
   * somebody who found you through Facebook two years ago and has just sent a
   * WhatsApp showed a Facebook badge. Two different facts; the source stays on
   * the contact and this stays on the message.
   */
  channel: Channel;
  direction: Direction;
  subject: string;
  body: string;
  /** Effective category: the override if one was set, otherwise the classifier's. */
  category: MsgCategory | null;
  /** True when a human set the category, so the UI can say so rather than imply certainty. */
  categoryIsOverride: boolean;
  unread: boolean;
  sentAt: string;
  deletedAt: string | null;
};

export type NewMessage = {
  direction: Direction;
  subject: string;
  body: string;
  contactId?: string | null;
  /**
   * Continue an existing conversation. Omit it and the message opens one.
   *
   * A reply MUST pass this. Without it every reply started a fresh thread, so
   * the threading was broken for precisely the case it exists to handle — and
   * silently, because a thread of one looks like a normal thread.
   */
  threadId?: string | null;
  /** The project it belongs to. Inherited by a reply from what it answers. */
  dealId?: string | null;
  /** Defaults to email, which is what this app's composer sends. */
  channel?: Channel;
  sentAt?: string | Date;
  /** Only set when a human chooses one; leave undefined to let the classifier decide. */
  category?: MsgCategory | null;
  unread?: boolean;
};

type Row = {
  id: string;
  contact_id: string | null;
  thread_id: string;
  deal_id: string | null;
  channel: Channel;
  direction: Direction;
  subject: string;
  body: string;
  category: MsgCategory | null;
  unread: boolean;
  sent_at: Date;
  deleted_at: Date | null;
};

const COLUMNS = `m.id, m.contact_id, m.thread_id, m.deal_id, m.channel, m.direction,
                 m.subject, m.body, m.category, m.unread, m.sent_at, m.deleted_at`;

function toRecord(r: Row): MessageRecord {
  // The classifier takes paragraphs, which is how the body was modelled before
  // it became a single column. Splitting here keeps its input identical, so an
  // existing message classifies the same way it always did.
  const paragraphs = r.body ? r.body.split(/\n\n+/) : [];
  return {
    id: r.id,
    contactId: r.contact_id,
    threadId: r.thread_id,
    dealId: r.deal_id,
    channel: r.channel,
    direction: r.direction,
    subject: r.subject,
    body: r.body,
    category: r.category ?? classifyMessage(r.subject, paragraphs) ?? null,
    categoryIsOverride: r.category !== null,
    unread: r.unread,
    sentAt: r.sent_at.toISOString(),
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  };
}

function newId(subject: string): string {
  const base = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  return `${base || "message"}-${Math.random().toString(36).slice(2, 8)}`;
}

function checkWhen(when: string | Date): Date {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) throw new Error("Message time is not a valid date.");
  return d;
}

/** The predicate that defines each folder. Kept in one place so they cannot overlap. */
function folderPredicate(folder: Folder): string {
  switch (folder) {
    case "trash":
      return "m.deleted_at IS NOT NULL";
    case "unread":
      return "m.deleted_at IS NULL AND m.unread AND m.direction = 'received'";
    case "sent":
      return "m.deleted_at IS NULL AND m.direction = 'sent'";
    case "inbox":
      return "m.deleted_at IS NULL AND m.direction = 'received'";
  }
}

export async function listMessages(q: TenantQuery, folder: Folder = "inbox"): Promise<MessageRecord[]> {
  if (!FOLDERS.includes(folder)) throw new Error(`Unknown folder: ${folder}`);
  const rows = await q.rows<Row>(
    `SELECT ${COLUMNS} FROM messages m
     WHERE m.sub_account_id = $1 AND ${folderPredicate(folder)}
     ORDER BY m.sent_at DESC, m.id`,
    [q.ctx.subAccountId]
  );
  return rows.map(toRecord);
}

/**
 * Read one message, including a trashed one.
 *
 * Opening a message from the bin has to work, so this deliberately does not
 * filter `deleted_at`. Callers that must not show deleted mail check
 * `deletedAt` on the record; making that visible is better than a second
 * function nobody remembers exists.
 */
export async function getMessage(q: TenantQuery, id: string): Promise<MessageRecord | null> {
  const row = await q.one<Row>(
    `SELECT ${COLUMNS} FROM messages m WHERE m.sub_account_id = $1 AND m.id = $2`,
    [q.ctx.subAccountId, id]
  );
  return row ? toRecord(row) : null;
}

export async function createMessage(q: TenantQuery, input: NewMessage): Promise<MessageRecord> {
  if (!DIRECTIONS.includes(input.direction)) {
    throw new Error(`Unknown direction: ${input.direction}`);
  }
  /* Its own id when nothing is being continued. Generated here rather than
     defaulted in SQL so the value is the same shape as the backfill's and there
     is exactly one place that decides what a thread id looks like. */
  const id = newId(input.subject);
  const row = await q.one<Row>(
    `WITH inserted AS (
       INSERT INTO messages
         (id, sub_account_id, contact_id, thread_id, deal_id, channel, direction,
          subject, body, category, unread, sent_at)
       VALUES ($2, $1, $3, COALESCE($10, 'th-' || $2), $11, COALESCE($12, 'email'),
               $4, $5, $6, $7, $8, COALESCE($9, now()))
       RETURNING *
     )
     SELECT ${COLUMNS} FROM inserted m WHERE m.sub_account_id = $1`,
    [
      q.ctx.subAccountId,
      id,
      input.contactId ?? null,
      input.direction,
      input.subject.trim(),
      input.body,
      input.category ?? null,
      // Something you sent is not unread mail. Defaulting it to true put every
      // outgoing message in the unread count.
      input.unread ?? input.direction === "received",
      input.sentAt ? checkWhen(input.sentAt) : null,
      input.threadId ?? null,
      input.dealId ?? null,
      input.channel ?? null,
    ]
  );
  if (!row) throw new Error("Message was not created.");
  return toRecord(row);
}

export async function setUnread(
  q: TenantQuery,
  id: string,
  unread: boolean
): Promise<MessageRecord | null> {
  const row = await q.one<Row>(
    `WITH updated AS (
       UPDATE messages SET unread = $3
       WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
       RETURNING *
     )
     SELECT ${COLUMNS} FROM updated m WHERE m.sub_account_id = $1`,
    [q.ctx.subAccountId, id, unread]
  );
  return row ? toRecord(row) : null;
}

/**
 * Override the classifier, or clear the override and hand it back.
 *
 * Passing null does not mean "no category" — it means "stop overriding", after
 * which the classifier's answer applies again. There is deliberately no way to
 * store an empty category, because a message always has whatever the rules say
 * it is.
 */
export async function setCategory(
  q: TenantQuery,
  id: string,
  category: MsgCategory | null
): Promise<MessageRecord | null> {
  const row = await q.one<Row>(
    `WITH updated AS (
       UPDATE messages SET category = $3
       WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
       RETURNING *
     )
     SELECT ${COLUMNS} FROM updated m WHERE m.sub_account_id = $1`,
    [q.ctx.subAccountId, id, category]
  );
  return row ? toRecord(row) : null;
}

export async function trashMessage(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE messages SET deleted_at = now()
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return row !== null;
}

/** How long a deleted message stays recoverable. */
export const TRASH_DAYS = 7;

/**
 * Empties the bin of anything deleted longer ago than that.
 *
 * A trash that only grows is not a trash, and "deleted" has to eventually mean
 * deleted — someone who asks for a message to be gone is owed that rather than
 * a hidden row that outlives them.
 *
 * Narrow on purpose. Scoped to the tenant like every query here, and to rows
 * that are ALREADY deleted, so the only thing it can reach is something this
 * account put in the bin itself more than a week ago. The interval is computed
 * by the database against `now()`, so it does not depend on what the web server
 * believes the time is, and the cutoff is a bound parameter rather than
 * interpolated text.
 *
 * Returns how many went, so a caller can say so rather than guess.
 */
export async function purgeExpiredMessages(q: TenantQuery): Promise<number> {
  const rows = await q.rows<{ id: string }>(
    `DELETE FROM messages
     WHERE sub_account_id = $1
       AND deleted_at IS NOT NULL
       AND deleted_at < now() - ($2::int * INTERVAL '1 day')
     RETURNING id`,
    [q.ctx.subAccountId, TRASH_DAYS]
  );
  return rows.length;
}

export async function restoreMessage(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE messages SET deleted_at = NULL
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NOT NULL RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return row !== null;
}

/**
 * The badge on the sidebar.
 *
 * Counted in SQL. Trashed mail is excluded — a number that keeps counting
 * messages the user has already binned trains them to ignore the badge.
 */
export async function unreadCount(q: TenantQuery): Promise<number> {
  const row = await q.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages m
     WHERE m.sub_account_id = $1 AND m.deleted_at IS NULL
       AND m.unread AND m.direction = 'received'`,
    [q.ctx.subAccountId]
  );
  return Number(row?.n ?? 0);
}

/**
 * File a whole conversation against a project — or unfile it.
 *
 * The THREAD, never a single message. Half a conversation on one job and half
 * on none is a state nobody asked for and everybody would have to reason about:
 * the project's thread list would show it, its message count would be wrong,
 * and the reply that mattered could be the half that is missing.
 *
 * The deal is confirmed to be in this tenant before anything is written. Row
 * level security refuses a foreign one anyway, but a caller passing an id from
 * another workspace should get an answer rather than a constraint violation.
 *
 * Returns how many messages moved, which is what lets the caller say
 * "3 messages filed" rather than a bare "done".
 */
export async function fileThread(
  q: TenantQuery,
  threadId: string,
  dealId: string | null
): Promise<{ moved: number } | { error: string }> {
  if (dealId !== null) {
    const deal = await q.one<{ id: string }>(
      `SELECT id FROM deals WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL`,
      [q.ctx.subAccountId, dealId]
    );
    if (!deal) return { error: "That project is not available on this account." };
  }

  const rows = await q.rows<{ id: string }>(
    `UPDATE messages SET deal_id = $3
      WHERE sub_account_id = $1 AND thread_id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [q.ctx.subAccountId, threadId, dealId]
  );
  return { moved: rows.length };
}

export type ProjectOption = {
  id: string;
  title: string;
  site: string | null;
  companyId: string | null;
  companyName: string | null;
};

/**
 * The projects a conversation could plausibly belong to.
 *
 * Live work only — filing mail against a job finished two years ago is almost
 * always a mis-tap, and the list stays short enough to be a choice rather than
 * a search.
 *
 * It returns the company each project is for and stops there. WHICH of them to
 * suggest depends on the message open at the time, and that changes with every
 * click; computing it here would mean re-reading every project on each one.
 * The screen matches `companyId` against the sender's own — see the inbox view.
 */
export async function projectOptions(q: TenantQuery): Promise<ProjectOption[]> {
  const rows = await q.rows<{
    id: string;
    title: string;
    site: string | null;
    company_id: string | null;
    company_name: string | null;
  }>(
    `SELECT d.id, d.title, d.site, d.company_id, co.name AS company_name
       FROM deals d
       LEFT JOIN companies co
              ON co.id = d.company_id AND co.deleted_at IS NULL
      WHERE d.sub_account_id = $1 AND d.deleted_at IS NULL
        AND d.stage IN ('prospect', 'discovery', 'demo', 'won', 'delivery')
      ORDER BY co.name NULLS LAST, d.title`,
    [q.ctx.subAccountId]
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    site: r.site,
    companyId: r.company_id,
    companyName: r.company_name,
  }));
}
