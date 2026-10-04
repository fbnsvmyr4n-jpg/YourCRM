import { randomBytes } from "node:crypto";
import type { TenantQuery } from "../tenant";
import { worthKeeping, type Draft } from "@/data/drafts";

export { worthKeeping, type Draft };

/**
 * Emails somebody started and has not sent.
 *
 * The composer keeps the box you are typing in right now in the browser, which
 * is the right place for it: no network on every keystroke, and nothing lost to
 * a dropped connection mid-sentence. What the browser is the WRONG place for is
 * everything after that. It held exactly one draft, it was invisible from any
 * other device, and clearing site data threw away a half-written reply to a
 * client without leaving a trace that it had existed.
 *
 * So this is where a draft goes when the composer closes: plural, durable, and
 * listed in its own folder.
 *
 * Every function here is scoped to ONE PERSON as well as one workspace. A
 * half-written message is a thought rather than a record — a colleague's
 * unfinished sentence is not something the rest of the workspace should be
 * reading over their shoulder. Tenant isolation is the outer fence and the
 * database enforces it; the user filter sits inside that, in the WHERE clause,
 * the same way `todos` scopes "mine".
 */

type Row = {
  id: string;
  to_address: string;
  subject: string;
  body: string;
  updated_at: Date;
};

const toDraft = (r: Row): Draft => ({
  id: r.id,
  to: r.to_address,
  subject: r.subject,
  body: r.body,
  updatedAt: r.updated_at.toISOString(),
});

/** This person's unsent messages, newest first. */
export async function listDrafts(q: TenantQuery): Promise<Draft[]> {
  if (!q.ctx.userId) return [];
  const rows = await q.rows<Row>(
    `SELECT id, to_address, subject, body, updated_at
       FROM message_drafts
      WHERE sub_account_id = $1 AND user_id = $2 AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 200`,
    [q.ctx.subAccountId, q.ctx.userId]
  );
  return rows.map(toDraft);
}

/**
 * Write a draft, creating it or replacing the one being edited.
 *
 * `id` is the draft the composer was opened from. Without it a new row is made,
 * which is what makes drafts plural — the old browser-storage draft was a
 * single slot, so starting a second message overwrote the first.
 */
export async function saveDraft(
  q: TenantQuery,
  draft: { id?: string | null; to: string; subject: string; body: string }
): Promise<Draft | null> {
  if (!q.ctx.userId) return null;
  if (!worthKeeping(draft)) return null;

  const values = [draft.to.slice(0, 320), draft.subject.slice(0, 200), draft.body.slice(0, 20000)];

  if (draft.id) {
    /* Scoped to this person as well as this workspace, so a known id from
       somebody else's draft updates nothing rather than rewriting theirs. */
    const updated = await q.rows<Row>(
      `UPDATE message_drafts
          SET to_address = $4, subject = $5, body = $6, updated_at = now()
        WHERE sub_account_id = $1 AND user_id = $2 AND id = $3 AND deleted_at IS NULL
        RETURNING id, to_address, subject, body, updated_at`,
      [q.ctx.subAccountId, q.ctx.userId, draft.id, ...values]
    );
    /* An id that matched nothing — deleted on another tab, or never theirs —
       falls through to a new row rather than silently losing the writing. */
    if (updated.length > 0) return toDraft(updated[0]);
  }

  const rows = await q.rows<Row>(
    `INSERT INTO message_drafts (id, sub_account_id, user_id, to_address, subject, body)
     VALUES ($3, $1, $2, $4, $5, $6)
     RETURNING id, to_address, subject, body, updated_at`,
    [q.ctx.subAccountId, q.ctx.userId, `dr_${randomBytes(12).toString("hex")}`, ...values]
  );
  return toDraft(rows[0]);
}

/**
 * Throw one away.
 *
 * Soft, like everything else here, so a draft discarded by a mis-click is still
 * in the table — and so the row survives long enough for anything referring to
 * it to stop. Nothing in the product reads a deleted draft.
 */
export async function discardDraft(q: TenantQuery, id: string): Promise<boolean> {
  if (!q.ctx.userId) return false;
  const rows = await q.rows<{ id: string }>(
    `UPDATE message_drafts SET deleted_at = now(), updated_at = now()
      WHERE sub_account_id = $1 AND user_id = $2 AND id = $3 AND deleted_at IS NULL
      RETURNING id`,
    [q.ctx.subAccountId, q.ctx.userId, id]
  );
  return rows.length > 0;
}
