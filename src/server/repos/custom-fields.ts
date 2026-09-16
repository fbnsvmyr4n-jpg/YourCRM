import type { TenantQuery } from "../tenant";
import {
  MAX_FIELDS_PER_ENTITY,
  type CustomField,
  type FieldEntity,
  type FieldKind,
  type FieldValues,
} from "../custom-field-rules";

/**
 * Custom field definitions and their values, as rows.
 *
 * Tenant-scoped like every CRM table: each statement filters `sub_account_id`
 * itself, row-level security enforces the same underneath, and a trigger
 * refuses a value that does not fit its field (see `schema.sql`).
 */

type FieldRow = {
  id: string;
  entity: FieldEntity;
  label: string;
  kind: FieldKind;
  options: string[] | null;
  archived_at: Date | null;
};

const toField = (r: FieldRow): CustomField => ({
  id: r.id,
  entity: r.entity,
  label: r.label,
  kind: r.kind,
  options: r.options ?? [],
  archived: r.archived_at !== null,
});

/** In the order they were added. Archived ones only when asked for. */
export async function listFields(
  q: TenantQuery,
  entity: FieldEntity,
  opts: { includeArchived?: boolean } = {}
): Promise<CustomField[]> {
  const rows = await q.rows<FieldRow>(
    `SELECT id, entity, label, kind, options, archived_at FROM custom_fields
      WHERE sub_account_id = $1 AND entity = $2
        AND ($3 OR archived_at IS NULL)
      ORDER BY position, created_at, id`,
    [q.ctx.subAccountId, entity, Boolean(opts.includeArchived)]
  );
  return rows.map(toField);
}

export async function getField(q: TenantQuery, id: string): Promise<CustomField | null> {
  const row = await q.one<FieldRow>(
    `SELECT id, entity, label, kind, options, archived_at FROM custom_fields
      WHERE sub_account_id = $1 AND id = $2`,
    [q.ctx.subAccountId, id]
  );
  return row ? toField(row) : null;
}

const LABEL_TAKEN = (label: string) => `There is already a field called “${label}”.`;

/**
 * Add a field at the end of the list.
 *
 * The label collision is caught rather than pre-checked — the unique index is
 * what actually decides, and a check-then-insert races — inside a savepoint so
 * the refusal does not poison the rest of the request.
 */
export async function createField(
  q: TenantQuery,
  id: string,
  entity: FieldEntity,
  def: { label: string; kind: FieldKind; options: string[] }
): Promise<{ field: CustomField } | { error: string }> {
  const live = await q.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM custom_fields
      WHERE sub_account_id = $1 AND entity = $2 AND archived_at IS NULL`,
    [q.ctx.subAccountId, entity]
  );
  if (Number(live?.n ?? 0) >= MAX_FIELDS_PER_ENTITY) {
    return { error: `You can have up to ${MAX_FIELDS_PER_ENTITY} fields here. Archive one you no longer use first.` };
  }

  try {
    const row = await q.attempt(() =>
      q.one<FieldRow>(
        `INSERT INTO custom_fields (id, sub_account_id, entity, label, kind, options, position)
         VALUES ($1, $2, $3, $4, $5, $6::text[],
                 (SELECT COALESCE(max(position), 0) + 1 FROM custom_fields
                   WHERE sub_account_id = $2 AND entity = $3))
         RETURNING id, entity, label, kind, options, archived_at`,
        [id, q.ctx.subAccountId, entity, def.label, def.kind, def.options]
      )
    );
    if (!row) return { error: "That field was not saved." };
    return { field: toField(row) };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { error: LABEL_TAKEN(def.label) };
    throw err;
  }
}

/**
 * Rename a field, or change a choice list's choices. Never its kind.
 *
 * A choice that is removed while records still hold it is left on those
 * records — it was true when it was typed — and simply stops being offered.
 */
export async function updateField(
  q: TenantQuery,
  id: string,
  def: { label: string; options: string[] }
): Promise<{ field: CustomField } | { error: string }> {
  try {
    const row = await q.attempt(() =>
      q.one<FieldRow>(
        `UPDATE custom_fields
            SET label = $3,
                options = CASE WHEN kind = 'choice' THEN $4::text[] ELSE options END,
                updated_at = now()
          WHERE sub_account_id = $1 AND id = $2
          RETURNING id, entity, label, kind, options, archived_at`,
        [q.ctx.subAccountId, id, def.label, def.options]
      )
    );
    return row ? { field: toField(row) } : { error: "That field no longer exists." };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { error: LABEL_TAKEN(def.label) };
    throw err;
  }
}

/** Put away, or bring back. Values are untouched either way. */
export async function setFieldArchived(
  q: TenantQuery,
  id: string,
  archived: boolean
): Promise<{ ok: true } | { error: string }> {
  try {
    const rows = await q.attempt(() =>
      q.rows<{ id: string }>(
        `UPDATE custom_fields
            SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END, updated_at = now()
          WHERE sub_account_id = $1 AND id = $2
          RETURNING id`,
        [q.ctx.subAccountId, id, archived]
      )
    );
    return rows.length ? { ok: true } : { error: "That field no longer exists." };
  } catch (err) {
    /* Restoring a field whose label a newer live field has since taken. */
    if ((err as { code?: string }).code === "23505") {
      return { error: "A live field already uses that name. Rename one of them first." };
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

type ValueRow = {
  record_id: string;
  field_id: string;
  value_text: string | null;
  value_number: string | null;
  value_date: string | null;
  value_bool: boolean | null;
};

/** The canonical string for a stored row. See `custom-field-rules.ts`. */
function canonical(r: ValueRow): string {
  if (r.value_bool !== null) return r.value_bool ? "yes" : "no";
  if (r.value_date !== null) return r.value_date;
  if (r.value_number !== null) {
    /* NUMERIC(19,4) comes back as "12.5000"; the canonical form drops the
       padding the column added. */
    return r.value_number.includes(".") ? r.value_number.replace(/\.?0+$/, "") : r.value_number;
  }
  return r.value_text ?? "";
}

/**
 * Every value for these records, keyed record → field → value.
 *
 * One statement for a whole list of records. Archived fields' values are
 * included; the screen decides what to show from the field list it holds.
 */
export async function valuesFor(
  q: TenantQuery,
  entity: FieldEntity,
  recordIds: readonly string[]
): Promise<Record<string, FieldValues>> {
  if (recordIds.length === 0) return {};
  const column = entity === "contact" ? "contact_id" : "deal_id";
  const rows = await q.rows<ValueRow>(
    `SELECT ${column} AS record_id, field_id, value_text, value_number::text AS value_number,
            value_date::text AS value_date, value_bool
       FROM custom_field_values
      WHERE sub_account_id = $1 AND ${column} = ANY($2::text[])`,
    [q.ctx.subAccountId, [...recordIds]]
  );
  const out: Record<string, FieldValues> = {};
  for (const r of rows) (out[r.record_id] ??= {})[r.field_id] = canonical(r);
  return out;
}

/**
 * Write the values for one record. `null` clears a value.
 *
 * Replace-then-insert per field rather than an upsert: the uniqueness is two
 * partial indexes, one per kind of record, and a delete followed by an insert
 * in the same transaction is simpler to read than choosing a conflict target by
 * entity. The trigger checks every insert.
 */
export async function saveValues(
  q: TenantQuery,
  entity: FieldEntity,
  recordId: string,
  changes: { field: Pick<CustomField, "id" | "kind">; value: string | null }[]
): Promise<void> {
  const column = entity === "contact" ? "contact_id" : "deal_id";
  for (const { field, value } of changes) {
    await q.rows(
      `DELETE FROM custom_field_values
        WHERE sub_account_id = $1 AND field_id = $2 AND ${column} = $3`,
      [q.ctx.subAccountId, field.id, recordId]
    );
    if (value === null) continue;
    await q.rows(
      `INSERT INTO custom_field_values
         (sub_account_id, field_id, ${column}, value_text, value_number, value_date, value_bool,
          updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5::numeric, $6::date, $7, $8)`,
      [
        q.ctx.subAccountId,
        field.id,
        recordId,
        field.kind === "text" || field.kind === "choice" ? value : null,
        field.kind === "number" ? value : null,
        field.kind === "date" ? value : null,
        field.kind === "yes_no" ? value === "yes" : null,
        q.ctx.userId || null,
      ]
    );
  }
}
