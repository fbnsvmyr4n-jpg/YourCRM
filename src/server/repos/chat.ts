import type { TenantQuery } from "../tenant";

/**
 * Assistant chat history.
 *
 * Scoped twice: to the sub-account by row-level security and the repo's own
 * predicate, and to the *user* within it. Two colleagues sharing a sub-account
 * must not see each other's conversations — they legitimately share every
 * contact and deal, but a chat thread is a person talking to an assistant, and
 * treating it as shared workspace data would be a surprising way to leak what
 * somebody asked.
 *
 * Cleared with a hard delete, uniquely in this codebase. "Clear chat" is a
 * person asking for their own conversation to be gone; a tombstone that quietly
 * kept it would make the button a lie, and there is no audit interest in what
 * someone asked an assistant.
 */

export const CHAT_ROLES = ["user", "assistant"] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  at: string;
};

type Row = {
  id: string;
  role: ChatRole;
  text: string;
  at: Date;
};

function toMessage(r: Row): ChatMessage {
  return { id: r.id, role: r.role, text: r.text, at: r.at.toISOString() };
}

/**
 * The conversation, oldest first.
 *
 * Chronological rather than newest-first: this is a transcript, and reading it
 * backwards is meaningless. The limit takes the most RECENT slice and then
 * restores order, so a long history truncates at the start like a chat window
 * rather than cutting off whatever was just said.
 */
export async function listChat(q: TenantQuery, limit = 200): Promise<ChatMessage[]> {
  const rows = await q.rows<Row>(
    `SELECT id, role, text, at FROM (
       SELECT c.id, c.role, c.text, c.at
       FROM chat_messages c
       WHERE c.sub_account_id = $1 AND c.user_id IS NOT DISTINCT FROM $2
       ORDER BY c.at DESC, c.id DESC
       LIMIT $3
     ) recent
     ORDER BY at ASC, id ASC`,
    [q.ctx.subAccountId, q.ctx.userId, limit]
  );
  return rows.map(toMessage);
}

export async function appendChat(
  q: TenantQuery,
  role: ChatRole,
  text: string
): Promise<ChatMessage> {
  if (!CHAT_ROLES.includes(role)) throw new Error(`Unknown chat role: ${role}`);
  if (!text.trim()) throw new Error("A chat message needs text.");

  const row = await q.one<Row>(
    `INSERT INTO chat_messages (id, sub_account_id, user_id, role, text)
     VALUES ($4, $1, $2, $3, $5)
     RETURNING id, role, text, at`,
    [
      q.ctx.subAccountId,
      q.ctx.userId,
      role,
      `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text.trim(),
    ]
  );
  if (!row) throw new Error("Chat message was not saved.");
  return toMessage(row);
}

/** Clear this user's conversation. Does not touch anyone else's. */
export async function clearChat(q: TenantQuery): Promise<number> {
  const rows = await q.rows<{ id: string }>(
    `DELETE FROM chat_messages
     WHERE sub_account_id = $1 AND user_id IS NOT DISTINCT FROM $2
     RETURNING id`,
    [q.ctx.subAccountId, q.ctx.userId]
  );
  return rows.length;
}
