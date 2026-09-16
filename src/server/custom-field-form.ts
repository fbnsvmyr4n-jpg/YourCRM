import type { TenantQuery } from "./tenant";
import { inputName, parseValue, type CustomField, type FieldEntity } from "./custom-field-rules";
import { listFields, saveValues, valuesFor } from "./repos/custom-fields";

/**
 * Custom field values, from a posted form to the database.
 *
 * Used by every form that edits a contact or a deal, so the three rules below
 * are written once:
 *
 *  1. **Only live fields are read.** An archived field's input is ignored even
 *     if a stale page still posts it; its stored values are left alone.
 *  2. **A field whose input is ABSENT is left unchanged.** A form opened before
 *     somebody added a field does not post it, and treating "not posted" as
 *     "cleared" would erase values other people typed. An input posted EMPTY
 *     clears the value.
 *  3. **Everything is checked before anything is written.** The caller parses
 *     first and writes the record only when every value is valid, so a bad
 *     number never leaves a half-saved edit behind.
 */

export type ParsedValues = {
  changes: { field: CustomField; value: string | null }[];
};

export async function parseCustomValues(
  q: TenantQuery,
  entity: FieldEntity,
  formData: FormData
): Promise<ParsedValues | { error: string }> {
  const fields = await listFields(q, entity);
  const changes: ParsedValues["changes"] = [];
  for (const field of fields) {
    const raw = formData.get(inputName(field.id));
    if (raw === null) continue;
    const parsed = parseValue(field, raw);
    if ("error" in parsed) return { error: parsed.error };
    changes.push({ field, value: parsed.value });
  }
  return { changes };
}

/**
 * Write what `parseCustomValues` accepted, and name the fields that actually
 * changed — for the "Details updated" line in the record's history.
 */
export async function applyCustomValues(
  q: TenantQuery,
  entity: FieldEntity,
  recordId: string,
  parsed: ParsedValues
): Promise<string[]> {
  if (parsed.changes.length === 0) return [];
  const before = (await valuesFor(q, entity, [recordId]))[recordId] ?? {};
  const real = parsed.changes.filter(({ field, value }) => (before[field.id] ?? null) !== value);
  await saveValues(q, entity, recordId, real);
  return real.map(({ field }) => field.label);
}
