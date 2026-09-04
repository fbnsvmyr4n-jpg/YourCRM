import type { TenantQuery } from "./tenant";

/**
 * Every note in one place.
 *
 * Notes are not stored in one place, which is the whole reason this file
 * exists. They arrive from two directions:
 *
 *  - as `activities` rows with `kind = 'note'`, which is how a note typed on a
 *    contact, a deal or a company is recorded;
 *  - and as the `notes` column on a meeting, which is written by the meeting's
 *    own notes box rather than logged as an activity.
 *
 * A page that read only the first would silently omit every meeting note, which
 * on this account is most of them. So both are read and merged here, once,
 * rather than each screen deciding for itself what "a note" means.
 *
 * Each row carries what it is ABOUT and a link back to it. A note without its
 * subject is the weakest possible version of itself — "they want it split over
 * two invoices" is worth nothing if you cannot tell who said it.
 */

export type NoteSubject = "contact" | "deal" | "company" | "meeting";

export type NoteEntry = {
  id: string;
  /** What the note is attached to. */
  kind: NoteSubject;
  /** The record's name — the person, the deal, the company, the meeting. */
  subject: string;
  body: string;
  at: string;
  /** Where to go to see it in context. */
  href: string;
};

type Row = {
  id: string;
  kind: NoteSubject;
  entity_id: string;
  subject: string | null;
  body: string;
  at: Date;
};

/** Where a note's own record lives, so a row can be opened rather than admired. */
function hrefFor(kind: NoteSubject, entityId: string): string {
  switch (kind) {
    case "contact":
      return `/contacts?open=${entityId}`;
    case "meeting":
      return "/meetings";
    case "company":
      return "/companies";
    case "deal":
      return "/deals";
  }
}

export async function listNotes(q: TenantQuery, limit = 200): Promise<NoteEntry[]> {
  const rows = await q.rows<Row>(
    /*
       One statement, two sources.
       
       The LEFT JOINs are each guarded by `entity_type`, so a note about a deal
       cannot pick up a contact that happens to share its id — entity ids are
       unique per table, not across them.

       Soft-deleted parents are excluded on purpose: a note about a contact who
       has been deleted has nothing left to open, and a row that goes nowhere is
       worse than one that is absent.
    */
    `SELECT * FROM (
       SELECT a.id,
              a.entity_type::text AS kind,
              a.entity_id,
              COALESCE(
                NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''),
                d.title,
                co.name,
                mt.topic
              ) AS subject,
              a.detail AS body,
              a.at
       FROM activities a
       LEFT JOIN contacts  c  ON a.entity_type = 'contact' AND c.id  = a.entity_id AND c.deleted_at  IS NULL
       LEFT JOIN deals     d  ON a.entity_type = 'deal'    AND d.id  = a.entity_id AND d.deleted_at  IS NULL
       LEFT JOIN companies co ON a.entity_type = 'company' AND co.id = a.entity_id AND co.deleted_at IS NULL
       LEFT JOIN meetings  mt ON a.entity_type = 'meeting' AND mt.id = a.entity_id AND mt.deleted_at IS NULL
       WHERE a.sub_account_id = $1
         AND a.kind = 'note'
         AND COALESCE(TRIM(a.detail), '') <> ''

       UNION ALL

       -- The meeting's own notes box, which is not logged as an activity.
       SELECT m.id, 'meeting', m.id, m.topic, m.notes, m.updated_at
       FROM meetings m
       WHERE m.sub_account_id = $1
         AND m.deleted_at IS NULL
         AND COALESCE(TRIM(m.notes), '') <> ''
     ) t
     WHERE t.subject IS NOT NULL
     ORDER BY t.at DESC
     LIMIT $2`,
    [q.ctx.subAccountId, limit]
  );

  return rows.map((r) => ({
    id: `${r.kind}-${r.id}`,
    kind: r.kind,
    subject: r.subject ?? "",
    body: r.body,
    at: r.at.toISOString(),
    href: hrefFor(r.kind, r.entity_id),
  }));
}
