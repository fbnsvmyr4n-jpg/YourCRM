import type { SystemQuery, TenantQuery } from "../tenant";

/**
 * The link a stranger opens.
 *
 * Two audiences, and the difference between them is the whole security story
 * of this file.
 *
 * The OWNER reads and writes their links through `TenantQuery`, like every
 * other record: row-level security applies, and they can only ever see their
 * own.
 *
 * The VISITOR has no session at all. Resolving `/book/acme-cranes` to a
 * workspace therefore cannot be tenant-scoped — there is no tenant yet; finding
 * it is the point. `resolveSlug` is that one lookup, and it is deliberately the
 * only thing in this file that takes a `SystemQuery`. It returns an id and the
 * booking terms and NOTHING ELSE: no contacts, no meetings, no staff, no
 * counts. Everything the page does afterwards happens inside `withTenant` for
 * the workspace it just found, so the unscoped read is one row wide and one row
 * deep.
 *
 * It also refuses a link that is not `enabled`, which is what makes publishing
 * a decision rather than a default.
 */

export const BOOKING_KINDS = ["online", "in_person"] as const;
export type BookingKind = (typeof BOOKING_KINDS)[number];

export type BookingLink = {
  id: string;
  slug: string;
  title: string;
  slotMinutes: number;
  noticeMinutes: number;
  daysAhead: number;
  kind: BookingKind;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/** What a visitor's page is allowed to know. */
export type PublicLink = {
  subAccountId: string;
  agencyId: string;
  /**
   * Whose diary this is, in the CRM's own terms.
   *
   * A visitor has no user, but a contact and a meeting created from a booking
   * need a real owner — both carry a foreign key to `users`, and more to the
   * point, an appointment nobody owns is one nobody is expected at. The
   * workspace's owner is used, so the booking lands on a real person's desk.
   */
  ownerUserId: string;
  workspaceName: string;
  slug: string;
  title: string;
  slotMinutes: number;
  noticeMinutes: number;
  daysAhead: number;
  kind: BookingKind;
};

type Row = {
  id: string;
  slug: string;
  title: string;
  slot_minutes: number;
  notice_minutes: number;
  days_ahead: number;
  kind: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = `id, slug, title, slot_minutes, notice_minutes, days_ahead, kind, enabled,
                 created_at, updated_at`;

const toLink = (r: Row): BookingLink => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  slotMinutes: r.slot_minutes,
  noticeMinutes: r.notice_minutes,
  daysAhead: r.days_ahead,
  kind: (BOOKING_KINDS as readonly string[]).includes(r.kind) ? (r.kind as BookingKind) : "online",
  enabled: r.enabled,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/**
 * Is this a slug at all?
 *
 * Checked before it reaches SQL, and again by the table's own CHECK. The shape
 * is deliberately narrow — lowercase, digits, hyphens, no leading or trailing
 * hyphen — because this ends up in a URL that people read to each other. It
 * also means a slug can never contain the characters that make a path
 * ambiguous.
 */
export function isSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(value);
}

/** Turn a business name into a first suggestion. Never stored without review. */
export function suggestSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return isSlug(base) ? base : "";
}

/* ------------------------------------------------------------------ */
/* The owner's side                                                    */
/* ------------------------------------------------------------------ */

export async function listBookingLinks(q: TenantQuery): Promise<BookingLink[]> {
  const rows = await q.rows<Row>(
    `SELECT ${COLUMNS} FROM booking_links WHERE sub_account_id = $1 ORDER BY created_at, id`,
    [q.ctx.subAccountId]
  );
  return rows.map(toLink);
}

export type SaveLink = {
  slug: string;
  title: string;
  slotMinutes: number;
  noticeMinutes: number;
  daysAhead: number;
  kind: BookingKind;
  enabled: boolean;
};

export type SaveResult = { link: BookingLink } | { error: string };

/**
 * Create or update this workspace's link.
 *
 * The slug collision is caught rather than pre-checked. A `SELECT … then
 * INSERT` is a check-then-act race, and the unique index is the only thing that
 * actually decides — so the insert is attempted and the violation is turned
 * into a sentence. Wrapped in `q.attempt` because catching a Postgres error
 * without a savepoint poisons the whole transaction, which is a bug this
 * project has now made three times.
 */
export async function saveBookingLink(
  q: TenantQuery,
  id: string,
  input: SaveLink
): Promise<SaveResult> {
  if (!isSlug(input.slug)) {
    return {
      error: "A link can use lowercase letters, numbers and hyphens, and must start and end with a letter or number.",
    };
  }

  try {
    const row = await q.attempt(() =>
      q.one<Row>(
        `INSERT INTO booking_links
           (id, sub_account_id, slug, title, slot_minutes, notice_minutes, days_ahead, kind, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           slug           = EXCLUDED.slug,
           title          = EXCLUDED.title,
           slot_minutes   = EXCLUDED.slot_minutes,
           notice_minutes = EXCLUDED.notice_minutes,
           days_ahead     = EXCLUDED.days_ahead,
           kind           = EXCLUDED.kind,
           enabled        = EXCLUDED.enabled,
           updated_at     = now()
         RETURNING ${COLUMNS}`,
        [
          id,
          q.ctx.subAccountId,
          input.slug,
          input.title,
          input.slotMinutes,
          input.noticeMinutes,
          input.daysAhead,
          input.kind,
          input.enabled,
        ]
      )
    );
    if (!row) return { error: "That link could not be saved." };
    return { link: toLink(row) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/booking_links_slug/.test(message)) {
      return { error: `“${input.slug}” is already taken. Try another.` };
    }
    if (/booking_links_slug_check|violates check constraint/.test(message)) {
      return { error: "Those booking settings are outside what a link allows." };
    }
    throw err;
  }
}

export async function deleteBookingLink(q: TenantQuery, id: string): Promise<boolean> {
  const rows = await q.rows<{ id: string }>(
    `DELETE FROM booking_links WHERE id = $2 AND sub_account_id = $1 RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* The visitor's side — the only unscoped read in this file            */
/* ------------------------------------------------------------------ */

/**
 * Find the workspace a public slug belongs to.
 *
 * Unscoped because a visitor has no tenant and finding one is the entire job.
 * Everything about this is deliberately narrow:
 *
 *   • one row, matched on an indexed lowercase slug;
 *   • `enabled` must be true, so an unpublished link does not exist as far as
 *     the internet is concerned;
 *   • the workspace must not be deleted;
 *   • it returns the booking terms and the workspace's NAME, because the
 *     visitor has to see whose diary they are looking at, and nothing else.
 *
 * Null for anything not found, never a partial answer — the page turns that
 * into a 404, so a disabled link and a nonexistent one are indistinguishable
 * from outside.
 */
export async function resolveSlug(sys: SystemQuery, raw: string): Promise<PublicLink | null> {
  /* A link read down a phone gets typed in capitals. Slugs are stored
     lowercase (the table's CHECK insists), so the URL is normalised to match —
     otherwise /book/Acme-Cranes is a 404 for the same page, which is what the
     first version did while its own schema comment promised the opposite.

     The `lower()` in the SQL below is then redundant, and a mutation run
     confirmed it: removing it changes nothing observable. It stays as the
     guard for the day somebody relaxes the CHECK. */
  const slug = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!isSlug(slug)) return null;

  const row = await sys.one<{
    sub_account_id: string;
    agency_id: string;
    owner_user_id: string | null;
    workspace_name: string;
    slug: string;
    title: string;
    slot_minutes: number;
    notice_minutes: number;
    days_ahead: number;
    kind: string;
  }>(
    `SELECT b.sub_account_id, s.agency_id, s.name AS workspace_name, b.slug, b.title,
            b.slot_minutes, b.notice_minutes, b.days_ahead, b.kind,
            -- Most senior first, then longest-serving. A workspace whose only
            -- owner has left still has somebody to hand the booking to.
            --
            -- Users are usually AGENCY-level, with no sub_account_id at all:
            -- that is how every real account in this product is shaped. The
            -- first version only looked for users attached to the workspace,
            -- found nobody on real data, and every published page 404'd. The
            -- tests passed because their fixture user happened to carry a
            -- sub_account_id. Both shapes are searched; same agency is the
            -- boundary, so a link can never be owned by another customer.
            (SELECT u.id FROM users u
              WHERE u.deleted_at IS NULL
                AND (u.sub_account_id = b.sub_account_id
                     OR (u.sub_account_id IS NULL AND u.agency_id = s.agency_id))
              ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                                   WHEN 'finance' THEN 2 ELSE 3 END,
                       -- A person attached to this workspace outranks an
                       -- agency-wide one of the same role: it is their diary.
                       (u.sub_account_id IS NULL),
                       u.created_at, u.id
              LIMIT 1) AS owner_user_id
       FROM booking_links b
       JOIN sub_accounts s ON s.id = b.sub_account_id
      WHERE lower(b.slug) = lower($1)
        AND b.enabled
        AND s.deleted_at IS NULL`,
    [slug]
  );
  if (!row) return null;
  /* A workspace with nobody left in it cannot take a booking: there would be no
     one to own the meeting and no one to turn up to it. Treated as not found,
     because that is what it is from outside. */
  if (!row.owner_user_id) return null;

  return {
    subAccountId: row.sub_account_id,
    agencyId: row.agency_id,
    ownerUserId: row.owner_user_id,
    workspaceName: row.workspace_name,
    slug: row.slug,
    title: row.title,
    slotMinutes: row.slot_minutes,
    noticeMinutes: row.notice_minutes,
    daysAhead: row.days_ahead,
    kind: (BOOKING_KINDS as readonly string[]).includes(row.kind)
      ? (row.kind as BookingKind)
      : "online",
  };
}
