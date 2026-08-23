import type { TenantQuery } from "./tenant";
import { restoreContact } from "./repos/contacts";
import { restoreCompany } from "./repos/companies";
import { restoreDeal } from "./repos/deals";
import { restoreMeeting } from "./repos/meetings";
import { restoreCall } from "./repos/calls";

/**
 * Everything that has been deleted, and the way back.
 *
 * Every delete in this product has been soft since the audit — `deleted_at` is
 * stamped and the row stops being readable rather than being destroyed. Six
 * entities delete that way; five had a `restore*` function waiting in their
 * repository, and exactly one of those five (the Inbox's) had a caller. So the
 * tombstones were being written and, for a contact or a deal, nobody could
 * reach them: the same shape as the pain-point defect, with a worse
 * consequence, because the record nobody could recover was a real prospect.
 *
 * This lives above the repositories rather than inside one because it reads
 * five of them. Repositories stay leaves.
 */

/**
 * Emails are deliberately absent.
 *
 * They are the one thing here that gets deleted routinely rather than by
 * mistake, and a workspace that clears fifty of them would bury the deleted
 * contact this list exists to find. The Inbox has its own Trash view, which is
 * where somebody looks for a deleted email anyway — `restoreMessage` is reached
 * from there and is not orphaned by this.
 */
export const TRASH_KINDS = ["contact", "company", "deal", "meeting", "call"] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];

export function isTrashKind(value: string): value is TrashKind {
  return (TRASH_KINDS as readonly string[]).includes(value);
}

export type TrashItem = {
  kind: TrashKind;
  id: string;
  /** What to call it on screen — never blank, never an id. */
  label: string;
  deletedAt: string;
};

/**
 * The most rows one listing may return.
 *
 * Recovery is about the thing you deleted a moment ago, not an archive of
 * everything ever removed. A workspace that has been running for a year would
 * otherwise render thousands of rows to help somebody find one.
 */
export const TRASH_LIMIT = 200;

/**
 * Where each kind lives, and what it is called.
 *
 * The table names are constants in this file, never anything that arrived from
 * a browser — the kind is validated against `TRASH_KINDS` and then used to look
 * up a row here, so no caller can steer the SQL.
 *
 * Every label expression ends in a literal fallback. A record whose name is
 * blank still has to be identifiable, and "Untitled deal · 2 minutes ago" is
 * recoverable where an empty row is not.
 */
const SPECS: Record<TrashKind, { table: string; noun: string; label: string }> = {
  contact: {
    table: "contacts",
    noun: "Contact",
    label: `coalesce(
      nullif(btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), ''),
      nullif(btrim(coalesce(email, '')), ''),
      nullif(btrim(coalesce(phone, '')), ''),
      'Unnamed contact')`,
  },
  company: {
    table: "companies",
    noun: "Company",
    label: `coalesce(nullif(btrim(name), ''), 'Unnamed company')`,
  },
  deal: {
    table: "deals",
    noun: "Deal",
    label: `coalesce(nullif(btrim(title), ''), 'Untitled deal')`,
  },
  meeting: {
    table: "meetings",
    noun: "Meeting",
    label: `coalesce(nullif(btrim(topic), ''), 'Untitled meeting')`,
  },
  call: {
    table: "calls",
    noun: "Call",
    label: `coalesce(
      nullif(btrim(caller_name), ''),
      nullif(btrim(coalesce(phone, '')), ''),
      'Unknown caller')`,
  },
};

export function nounFor(kind: TrashKind): string {
  return SPECS[kind].noun;
}

/**
 * Everything deleted in this workspace, newest first.
 *
 * One query rather than six. Six round trips would each need their own ordering
 * and then be merged in JavaScript, and the merge is where an interleaved list
 * gets its ordering subtly wrong — the database sorts the union correctly for
 * free.
 *
 * `sub_account_id` is in every branch even though row-level security already
 * constrains the read. It costs nothing, it keeps the indexes in play, and it
 * means this still returns one workspace's rows if it is ever called on a
 * connection where the policy is not in force.
 */
export async function listTrash(q: TenantQuery, limit = TRASH_LIMIT): Promise<TrashItem[]> {
  const branches = TRASH_KINDS.map((kind) => {
    const spec = SPECS[kind];
    return `SELECT '${kind}'::text AS kind, id, (${spec.label}) AS label, deleted_at
            FROM ${spec.table}
            WHERE sub_account_id = $1 AND deleted_at IS NOT NULL`;
  });

  const rows = await q.rows<{ kind: string; id: string; label: string; deleted_at: Date }>(
    `${branches.join("\nUNION ALL\n")}
     ORDER BY deleted_at DESC, id
     LIMIT $2`,
    [q.ctx.subAccountId, Math.max(0, Math.min(limit, TRASH_LIMIT))]
  );

  return rows.map((r) => ({
    kind: r.kind as TrashKind,
    id: r.id,
    label: r.label,
    deletedAt: r.deleted_at.toISOString(),
  }));
}

/** How many deleted records are waiting, without loading them. */
export async function trashCount(q: TenantQuery): Promise<number> {
  const branches = TRASH_KINDS.map(
    (kind) =>
      `SELECT count(*) AS n FROM ${SPECS[kind].table}
       WHERE sub_account_id = $1 AND deleted_at IS NOT NULL`
  );
  const row = await q.one<{ n: string }>(
    `SELECT sum(n)::text AS n FROM (${branches.join(" UNION ALL ")}) AS t`,
    [q.ctx.subAccountId]
  );
  return Number(row?.n ?? 0);
}

/**
 * Put one record back.
 *
 * Dispatches to the repository that owns the record rather than issuing the
 * UPDATE here. Each repository decides what restoring its own entity means, and
 * a second copy of that decision in this file is a second copy to keep in step.
 *
 * Restoring is deliberately one record at a time and never cascades. A deleted
 * contact whose deals were deleted with it comes back alone, because the
 * alternative — reviving everything stamped at the same moment — would undo far
 * more than the person asked for, and there is no way to tell from a timestamp
 * which of those deletions they actually regret.
 */
const RESTORERS: Record<TrashKind, (q: TenantQuery, id: string) => Promise<boolean>> = {
  contact: restoreContact,
  company: restoreCompany,
  deal: restoreDeal,
  meeting: restoreMeeting,
  call: restoreCall,
};

export async function restoreFromTrash(
  q: TenantQuery,
  kind: TrashKind,
  id: string
): Promise<boolean> {
  return RESTORERS[kind](q, id);
}
