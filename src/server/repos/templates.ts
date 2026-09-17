import { randomBytes } from "node:crypto";
import type { TenantQuery } from "../tenant";
import type { MessageTemplate, TemplateChannel, TemplateInput } from "../template-rules";

/**
 * Message templates as rows. Every statement filters `sub_account_id` itself;
 * row-level security enforces the same underneath.
 */

type Row = {
  id: string;
  name: string;
  channel: TemplateChannel;
  subject: string;
  body: string;
  created_by_user_id: string | null;
  updated_at: Date;
};

const COLUMNS = `id, name, channel, subject, body, created_by_user_id, updated_at`;

const toTemplate = (r: Row): MessageTemplate => ({
  id: r.id,
  name: r.name,
  channel: r.channel,
  subject: r.subject,
  body: r.body,
  createdBy: r.created_by_user_id,
  updatedAt: r.updated_at.toISOString(),
});

/** Per workspace. A list past this is one nobody scrolls. */
export const MAX_TEMPLATES = 100;

const clash = (err: unknown) => (err as { code?: string }).code === "23505";

export async function listTemplates(q: TenantQuery): Promise<MessageTemplate[]> {
  const rows = await q.rows<Row>(
    `SELECT ${COLUMNS} FROM message_templates WHERE sub_account_id = $1 ORDER BY lower(name), id`,
    [q.ctx.subAccountId]
  );
  return rows.map(toTemplate);
}

export async function getTemplate(q: TenantQuery, id: string): Promise<MessageTemplate | null> {
  const row = await q.one<Row>(`SELECT ${COLUMNS} FROM message_templates WHERE sub_account_id = $1 AND id = $2`, [
    q.ctx.subAccountId,
    id,
  ]);
  return row ? toTemplate(row) : null;
}

export async function createTemplate(
  q: TenantQuery,
  input: TemplateInput
): Promise<{ template: MessageTemplate } | { error: string }> {
  const count = await q.one<{ n: string }>(`SELECT count(*)::text AS n FROM message_templates WHERE sub_account_id = $1`, [
    q.ctx.subAccountId,
  ]);
  if (Number(count?.n ?? 0) >= MAX_TEMPLATES) {
    return { error: `A workspace can keep up to ${MAX_TEMPLATES} templates. Delete one you no longer use first.` };
  }
  try {
    const row = await q.attempt(() =>
      q.one<Row>(
        `INSERT INTO message_templates (id, sub_account_id, name, channel, subject, body, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLUMNS}`,
        [
          `mt_${randomBytes(12).toString("hex")}`,
          q.ctx.subAccountId,
          input.name,
          input.channel,
          input.subject,
          input.body,
          q.ctx.userId || null,
        ]
      )
    );
    return { template: toTemplate(row!) };
  } catch (err) {
    if (clash(err)) return { error: `There is already a template called “${input.name}”.` };
    throw err;
  }
}

export async function updateTemplate(
  q: TenantQuery,
  id: string,
  input: TemplateInput
): Promise<{ template: MessageTemplate } | { error: string }> {
  try {
    const row = await q.attempt(() =>
      q.one<Row>(
        `UPDATE message_templates
            SET name = $3, channel = $4, subject = $5, body = $6, updated_at = now()
          WHERE sub_account_id = $1 AND id = $2
          RETURNING ${COLUMNS}`,
        [q.ctx.subAccountId, id, input.name, input.channel, input.subject, input.body]
      )
    );
    return row ? { template: toTemplate(row) } : { error: "That template no longer exists." };
  } catch (err) {
    if (clash(err)) return { error: `There is already a template called “${input.name}”.` };
    throw err;
  }
}

export async function deleteTemplate(q: TenantQuery, id: string): Promise<boolean> {
  const rows = await q.rows<{ id: string }>(
    `DELETE FROM message_templates WHERE sub_account_id = $1 AND id = $2 RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return rows.length > 0;
}
