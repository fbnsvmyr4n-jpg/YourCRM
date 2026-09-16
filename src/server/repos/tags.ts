import type { TenantQuery } from "../tenant";
import { BULK_LIMIT } from "./contacts";
import {
  MAX_TAGS,
  MAX_VIEWS,
  parseFilter,
  TAG_COLORS,
  type ContactFilter,
  type SavedView,
  type Tag,
  type TagColor,
} from "../contact-filter";

/**
 * Tags on contacts, and saved views, as rows.
 *
 * Tenant-scoped like every CRM table: each statement filters `sub_account_id`
 * itself, row-level security enforces the same underneath, and a trigger
 * refuses a tag or contact from another workspace.
 */

const refusedByDatabase = (err: unknown, code: string) => (err as { code?: string }).code === code;

/** Every tag, with how many live contacts carry it, alphabetically. */
export async function listTags(q: TenantQuery): Promise<Tag[]> {
  const rows = await q.rows<{ id: string; name: string; color: TagColor; contacts: string }>(
    `SELECT t.id, t.name, t.color,
            (SELECT count(*) FROM contact_tags ct
               JOIN contacts c ON c.id = ct.contact_id AND c.sub_account_id = ct.sub_account_id
              WHERE ct.sub_account_id = t.sub_account_id AND ct.tag_id = t.id
                AND c.deleted_at IS NULL)::text AS contacts
       FROM tags t
      WHERE t.sub_account_id = $1
      ORDER BY lower(t.name), t.id`,
    [q.ctx.subAccountId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, contacts: Number(r.contacts) }));
}

/** contactId → the ids of its tags. One statement for the whole list. */
export async function tagIdsByContact(q: TenantQuery): Promise<Record<string, string[]>> {
  const rows = await q.rows<{ contact_id: string; tag_id: string }>(
    `SELECT ct.contact_id, ct.tag_id FROM contact_tags ct
       JOIN tags t ON t.id = ct.tag_id AND t.sub_account_id = ct.sub_account_id
      WHERE ct.sub_account_id = $1
      ORDER BY lower(t.name)`,
    [q.ctx.subAccountId]
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.contact_id] ??= []).push(r.tag_id);
  return out;
}

export async function createTag(
  q: TenantQuery,
  name: string,
  color: TagColor
): Promise<{ tag: Tag } | { error: string }> {
  if (!(TAG_COLORS as readonly string[]).includes(color)) return { error: "That is not a tag colour." };
  const count = await q.one<{ n: string }>(`SELECT count(*)::text AS n FROM tags WHERE sub_account_id = $1`, [
    q.ctx.subAccountId,
  ]);
  if (Number(count?.n ?? 0) >= MAX_TAGS) {
    return { error: `A workspace can have up to ${MAX_TAGS} tags. Remove one you no longer use first.` };
  }
  const id = `tg_${crypto.randomUUID().replace(/-/g, "")}`;
  try {
    await q.attempt(() =>
      q.rows(`INSERT INTO tags (id, sub_account_id, name, color) VALUES ($1, $2, $3, $4)`, [
        id,
        q.ctx.subAccountId,
        name,
        color,
      ])
    );
  } catch (err) {
    if (refusedByDatabase(err, "23505")) return { error: `There is already a tag called “${name}”.` };
    throw err;
  }
  return { tag: { id, name, color, contacts: 0 } };
}

/** The existing tag with this name, ignoring case — how typing a tag reuses one. */
export async function findTagByName(q: TenantQuery, name: string): Promise<Tag | null> {
  const row = await q.one<{ id: string; name: string; color: TagColor }>(
    `SELECT id, name, color FROM tags WHERE sub_account_id = $1 AND lower(name) = lower($2)`,
    [q.ctx.subAccountId, name]
  );
  return row ? { ...row, contacts: 0 } : null;
}

export async function updateTag(
  q: TenantQuery,
  id: string,
  patch: { name: string; color: TagColor }
): Promise<{ ok: true } | { error: string }> {
  if (!(TAG_COLORS as readonly string[]).includes(patch.color)) return { error: "That is not a tag colour." };
  try {
    const rows = await q.attempt(() =>
      q.rows<{ id: string }>(
        `UPDATE tags SET name = $3, color = $4 WHERE sub_account_id = $1 AND id = $2 RETURNING id`,
        [q.ctx.subAccountId, id, patch.name, patch.color]
      )
    );
    return rows.length ? { ok: true } : { error: "That tag no longer exists." };
  } catch (err) {
    if (refusedByDatabase(err, "23505")) return { error: `There is already a tag called “${patch.name}”.` };
    throw err;
  }
}

/** Removes the label from every contact. The contacts are untouched. */
export async function deleteTag(q: TenantQuery, id: string): Promise<boolean> {
  const rows = await q.rows<{ id: string }>(`DELETE FROM tags WHERE sub_account_id = $1 AND id = $2 RETURNING id`, [
    q.ctx.subAccountId,
    id,
  ]);
  return rows.length > 0;
}

/**
 * Put a tag on contacts, or take it off. Returns how many actually changed.
 *
 * One statement for the whole selection, capped like every bulk change. An id
 * from another workspace, or a contact already carrying the tag, changes
 * nothing and is not counted.
 */
export async function setTagOnContacts(
  q: TenantQuery,
  tagId: string,
  contactIds: string[],
  on: boolean
): Promise<number> {
  const ids = contactIds.slice(0, BULK_LIMIT);
  if (ids.length === 0) return 0;
  if (on) {
    const rows = await q.rows<{ contact_id: string }>(
      `INSERT INTO contact_tags (sub_account_id, contact_id, tag_id)
       SELECT $1, c.id, t.id
         FROM contacts c
         JOIN tags t ON t.id = $2 AND t.sub_account_id = $1
        WHERE c.id = ANY($3) AND c.sub_account_id = $1 AND c.deleted_at IS NULL
       ON CONFLICT DO NOTHING
       RETURNING contact_id`,
      [q.ctx.subAccountId, tagId, ids]
    );
    return rows.length;
  }
  const rows = await q.rows<{ contact_id: string }>(
    `DELETE FROM contact_tags
      WHERE sub_account_id = $1 AND tag_id = $2 AND contact_id = ANY($3)
      RETURNING contact_id`,
    [q.ctx.subAccountId, tagId, ids]
  );
  return rows.length;
}

/* ------------------------------------------------------------------ */
/* Saved views                                                         */
/* ------------------------------------------------------------------ */

export async function listViews(q: TenantQuery, knownTagIds: ReadonlySet<string>): Promise<SavedView[]> {
  const rows = await q.rows<{ id: string; name: string; filter: unknown; created_by_user_id: string | null }>(
    `SELECT id, name, filter, created_by_user_id FROM contact_views WHERE sub_account_id = $1 ORDER BY lower(name), id`,
    [q.ctx.subAccountId]
  );
  /* Checked on the way OUT as well as in: a view naming a tag deleted since
     still opens, showing what it still can. */
  return rows.map((r) => ({ id: r.id, name: r.name, filter: parseFilter(r.filter, knownTagIds), createdBy: r.created_by_user_id }));
}

export async function saveView(
  q: TenantQuery,
  name: string,
  filter: ContactFilter
): Promise<{ view: SavedView } | { error: string }> {
  const count = await q.one<{ n: string }>(`SELECT count(*)::text AS n FROM contact_views WHERE sub_account_id = $1`, [
    q.ctx.subAccountId,
  ]);
  if (Number(count?.n ?? 0) >= MAX_VIEWS) {
    return { error: `A workspace can have up to ${MAX_VIEWS} saved views. Delete one you no longer use first.` };
  }
  const id = `cv_${crypto.randomUUID().replace(/-/g, "")}`;
  try {
    await q.attempt(() =>
      q.rows(
        `INSERT INTO contact_views (id, sub_account_id, name, filter, created_by_user_id)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [id, q.ctx.subAccountId, name, JSON.stringify(filter), q.ctx.userId || null]
      )
    );
  } catch (err) {
    if (refusedByDatabase(err, "23505")) return { error: `There is already a view called “${name}”.` };
    throw err;
  }
  return { view: { id, name, filter, createdBy: q.ctx.userId || null } };
}

export async function deleteView(q: TenantQuery, id: string): Promise<boolean> {
  const rows = await q.rows<{ id: string }>(
    `DELETE FROM contact_views WHERE sub_account_id = $1 AND id = $2 RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return rows.length > 0;
}
