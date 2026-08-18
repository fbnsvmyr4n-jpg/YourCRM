import type { TenantQuery } from "../tenant";

/**
 * Deals — the pipeline, on Bradley's six stages.
 *
 * Same two isolation controls as every repository here: each statement filters
 * `sub_account_id` itself, and row-level security enforces the same thing
 * underneath. See `repos/contacts.ts` for why both, rather than either.
 *
 * What is specific to this module is that the pipeline does not end at the
 * sale. Delivery and Referral are post-close, which makes "is this deal won?"
 * and "is this deal still open?" two different questions with two different
 * answers — and getting that wrong is what made the previous version's
 * analytics untrue.
 */

export const STAGES = [
  "prospect",
  "discovery",
  "demo",
  "won",
  "delivery",
  "referral",
  "lost",
] as const;
export type Stage = (typeof STAGES)[number];

export const SOURCES = [
  "google_ads",
  "facebook",
  "referral",
  "phone_call",
  "website",
  "outbound",
  "other",
] as const;
export type Source = (typeof SOURCES)[number];

/** Before the close. A deal here is what the UI calls a lead. */
export const OPEN_STAGES = ["prospect", "discovery", "demo"] as const;
/** After the close. These belong to a client, and the money is already counted. */
export const CLOSED_WON_STAGES = ["won", "delivery", "referral"] as const;

export type DealRecord = {
  id: string;
  contactId: string | null;
  ownerUserId: string | null;
  title: string;
  /**
   * Integer cents. Postgres returns BIGINT as a string to avoid the precision
   * loss of a JavaScript number, so it is converted deliberately here rather
   * than arriving as `"500000"` and silently concatenating somewhere upstream.
   */
  valueCents: number;
  stage: Stage;
  source: Source;
  lostReason: string | null;
  wonAt: string | null;
  /** Captured in Discovery, and the input to the Demo. */
  painPoints: string[];
  referredByContactId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewDeal = {
  title: string;
  contactId?: string | null;
  ownerUserId?: string | null;
  valueCents?: number;
  stage?: Stage;
  source?: Source;
  painPoints?: string[];
  referredByContactId?: string | null;
};

type Row = {
  id: string;
  contact_id: string | null;
  owner_user_id: string | null;
  title: string;
  value_cents: string;
  stage: Stage;
  source: Source;
  lost_reason: string | null;
  won_at: Date | null;
  pain_points: string[];
  referred_by_contact_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const SELECT = `
  SELECT d.id, d.contact_id, d.owner_user_id, d.title, d.value_cents, d.stage,
         d.source, d.lost_reason, d.won_at, d.pain_points,
         d.referred_by_contact_id, d.created_at, d.updated_at
  FROM deals d
  WHERE d.deleted_at IS NULL AND d.sub_account_id = $1`;

function toRecord(r: Row): DealRecord {
  return {
    id: r.id,
    contactId: r.contact_id,
    ownerUserId: r.owner_user_id,
    title: r.title,
    valueCents: Number(r.value_cents),
    stage: r.stage,
    source: r.source,
    lostReason: r.lost_reason,
    wonAt: r.won_at ? r.won_at.toISOString() : null,
    painPoints: r.pain_points ?? [],
    referredByContactId: r.referred_by_contact_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function newId(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  return `${base || "deal"}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Money must be whole cents.
 *
 * A float here is how a total ends up at 1234.9999999999998, and the audit's
 * rule is that money is integer cents everywhere. Rejecting loudly beats
 * rounding quietly: a rounded value is wrong in a way nobody notices until it
 * is reconciled against a bank statement.
 */
function checkMoney(cents: number): number {
  if (!Number.isInteger(cents)) throw new Error("Deal value must be whole cents.");
  if (cents < 0) throw new Error("Deal value cannot be negative.");
  if (!Number.isSafeInteger(cents)) throw new Error("Deal value is out of range.");
  return cents;
}

export async function listDeals(q: TenantQuery): Promise<DealRecord[]> {
  const rows = await q.rows<Row>(`${SELECT} ORDER BY d.created_at DESC, d.id`, [
    q.ctx.subAccountId,
  ]);
  return rows.map(toRecord);
}

export async function getDeal(q: TenantQuery, id: string): Promise<DealRecord | null> {
  const row = await q.one<Row>(`${SELECT} AND d.id = $2`, [q.ctx.subAccountId, id]);
  return row ? toRecord(row) : null;
}

export async function listDealsForContact(
  q: TenantQuery,
  contactId: string
): Promise<DealRecord[]> {
  const rows = await q.rows<Row>(`${SELECT} AND d.contact_id = $2 ORDER BY d.created_at DESC`, [
    q.ctx.subAccountId,
    contactId,
  ]);
  return rows.map(toRecord);
}

export async function createDeal(q: TenantQuery, input: NewDeal): Promise<DealRecord> {
  const stage = input.stage ?? "prospect";
  const row = await q.one<Row>(
    `WITH inserted AS (
       INSERT INTO deals
         (id, sub_account_id, contact_id, owner_user_id, title, value_cents, stage,
          source, pain_points, referred_by_contact_id, won_at)
       VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9::jsonb, $10,
               CASE WHEN $7 = 'won' THEN now() ELSE NULL END)
       RETURNING *
     )
     ${SELECT.replace("FROM deals d", "FROM inserted d")}`,
    [
      q.ctx.subAccountId,
      newId(input.title),
      input.contactId ?? null,
      input.ownerUserId ?? null,
      input.title.trim(),
      checkMoney(input.valueCents ?? 0),
      stage,
      input.source ?? "other",
      JSON.stringify(input.painPoints ?? []),
      input.referredByContactId ?? null,
    ]
  );
  if (!row) throw new Error("Deal was not created.");
  return toRecord(row);
}

export async function updateDeal(
  q: TenantQuery,
  id: string,
  patch: Partial<Omit<NewDeal, "stage">>
): Promise<DealRecord | null> {
  if (patch.valueCents !== undefined) checkMoney(patch.valueCents);

  // Stage is deliberately not settable here. It carries side effects on
  // `won_at` and `lost_reason`, and a plain field assignment would skip them
  // and leave the row internally inconsistent. Use `moveStage`.
  const row = await q.one<Row>(
    `WITH updated AS (
       UPDATE deals SET
         title         = COALESCE($3, title),
         value_cents   = COALESCE($4, value_cents),
         contact_id    = CASE WHEN $5::boolean  THEN $6  ELSE contact_id END,
         owner_user_id = CASE WHEN $7::boolean  THEN $8  ELSE owner_user_id END,
         source        = COALESCE($9, source),
         pain_points   = COALESCE($10::jsonb, pain_points),
         referred_by_contact_id = CASE WHEN $11::boolean THEN $12 ELSE referred_by_contact_id END,
         updated_at    = now()
       WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
       RETURNING *
     )
     ${SELECT.replace("FROM deals d", "FROM updated d")}`,
    [
      q.ctx.subAccountId,
      id,
      patch.title?.trim() ?? null,
      patch.valueCents ?? null,
      patch.contactId !== undefined,
      patch.contactId ?? null,
      patch.ownerUserId !== undefined,
      patch.ownerUserId ?? null,
      patch.source ?? null,
      patch.painPoints ? JSON.stringify(patch.painPoints) : null,
      patch.referredByContactId !== undefined,
      patch.referredByContactId ?? null,
    ]
  );
  return row ? toRecord(row) : null;
}

/**
 * Move a deal through the pipeline, keeping the row consistent with itself.
 *
 * `won_at` records the fact that payment happened, and the fact must survive
 * the deal moving on to Delivery and then Referral — those are post-close
 * stages in Bradley's process, and a client who stopped counting as won the
 * moment work began would make revenue fall as delivery succeeded.
 *
 * Moving *backwards* out of a closed stage is the opposite case: the sale
 * un-happened, so the timestamp must go, or revenue keeps counting a deal that
 * is back in Discovery. The same applies to `lost_reason` when a lost deal is
 * revived. Both are cleared here rather than left for a caller to remember.
 */
export async function moveStage(
  q: TenantQuery,
  id: string,
  stage: Stage,
  opts: { lostReason?: string | null } = {}
): Promise<DealRecord | null> {
  if (!STAGES.includes(stage)) throw new Error(`Unknown stage: ${stage}`);
  if (stage === "lost" && !opts.lostReason?.trim()) {
    // Loss reasons are the input to the "why we lose" analysis. Allowing a
    // blank one means the report is built from whichever losses someone
    // happened to annotate, which is worse than having no report.
    throw new Error("A lost deal needs a reason.");
  }

  const row = await q.one<Row>(
    `WITH updated AS (
       UPDATE deals SET
         stage = $3,
         won_at = CASE
           WHEN $3 = 'won' AND won_at IS NULL THEN now()
           WHEN $3 IN ('delivery', 'referral') THEN won_at
           WHEN $3 = 'won' THEN won_at
           ELSE NULL
         END,
         lost_reason = CASE WHEN $3 = 'lost' THEN $4 ELSE NULL END,
         updated_at = now()
       WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
       RETURNING *
     )
     ${SELECT.replace("FROM deals d", "FROM updated d")}`,
    [q.ctx.subAccountId, id, stage, opts.lostReason?.trim() ?? null]
  );
  return row ? toRecord(row) : null;
}

/** Add pain points discovered on a call, without disturbing the ones already there. */
export async function addPainPoints(
  q: TenantQuery,
  id: string,
  points: string[]
): Promise<DealRecord | null> {
  const cleaned = points.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length === 0) return getDeal(q, id);

  // Appended in SQL rather than read-modify-write: two people finishing calls
  // on the same deal would otherwise each write back the array they read, and
  // the second would erase the first. That exact class of loss was measured on
  // the old store at 18 of 20 records.
  const row = await q.one<Row>(
    `WITH updated AS (
       UPDATE deals
       SET pain_points = pain_points || $3::jsonb, updated_at = now()
       WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
       RETURNING *
     )
     ${SELECT.replace("FROM deals d", "FROM updated d")}`,
    [q.ctx.subAccountId, id, JSON.stringify(cleaned)]
  );
  return row ? toRecord(row) : null;
}

export async function deleteDeal(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE deals SET deleted_at = now(), updated_at = now()
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return row !== null;
}

export async function restoreDeal(q: TenantQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE deals SET deleted_at = NULL, updated_at = now()
     WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NOT NULL RETURNING id`,
    [q.ctx.subAccountId, id]
  );
  return row !== null;
}

/**
 * Assign, reassign or unassign the owner of this record.
 *
 * Separate from the general update for the same reason a stage change is: it
 * is a claim about who is responsible, not a form field, and it is the one
 * write the database refuses on grounds the caller cannot see from the row.
 *
 * A database trigger rejects an owner from another tenant — a plain foreign key
 * cannot express that, because the tenant is on this row and the agency is on
 * the user. The check runs there rather than only here so an import script or a
 * future endpoint cannot skip it. This turns its error into a readable one;
 * it does not replace it.
 *
 * `null` unassigns, which is always allowed.
 */
export async function assignOwner(
  q: TenantQuery,
  id: string,
  ownerUserId: string | null
): Promise<{ record?: DealRecord; error?: string }> {
  try {
    const row = await q.one<Row>(
      `WITH updated AS (
         UPDATE deals SET owner_user_id = $3
         WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL
         RETURNING *
       )
       ${SELECT.replace("FROM deals d", "FROM updated d").replace("$1", "$1")}`,
      [q.ctx.subAccountId, id, ownerUserId]
    );
    return row ? { record: toRecord(row) } : { error: "That record no longer exists." };
  } catch (err) {
    if (String(err).includes("does not belong to sub-account")) {
      return { error: "That person is not a member of this account." };
    }
    throw err;
  }
}

/** Everything assigned to one person — or, with null, everything unassigned. */
export async function listByOwner(
  q: TenantQuery,
  ownerUserId: string | null
): Promise<DealRecord[]> {
  const rows = await q.rows<Row>(
    `${SELECT} AND d.owner_user_id IS NOT DISTINCT FROM $2`,
    [q.ctx.subAccountId, ownerUserId]
  );
  return rows.map(toRecord);
}

