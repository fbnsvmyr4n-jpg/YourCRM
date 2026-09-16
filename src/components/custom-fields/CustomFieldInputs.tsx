"use client";

import { clsx } from "@/lib/clsx";
import {
  inputName,
  MAX_TEXT_VALUE,
  type CustomField,
  type FieldValues,
} from "@/server/custom-field-rules";

/**
 * One input per custom field, of the right kind, for a record's edit form.
 *
 * Rendered as siblings, not wrapped, so each form lays them out on its own grid
 * beside its own fields. Every input is ALWAYS posted — an empty one means
 * "clear it" — which is the half of the contract the server relies on to tell
 * a cleared value from a field this form never knew about.
 *
 * Numbers use a text input with a decimal keypad rather than `type="number"`:
 * the number input rejects "12,500" outright and silently posts nothing, which
 * would clear the value somebody thought they had typed.
 */
export function CustomFieldInputs({
  fields,
  values,
  itemClassName,
}: {
  /** Live fields only, in display order. */
  fields: CustomField[];
  values: FieldValues;
  itemClassName?: string;
}) {
  return (
    <>
      {fields.map((field) => {
        const name = inputName(field.id);
        const current = values[field.id] ?? "";
        return (
          <label key={field.id} className={clsx("block min-w-0", itemClassName)}>
            <span className="mb-1.5 block truncate text-xs font-medium text-muted">{field.label}</span>
            {field.kind === "choice" || field.kind === "yes_no" ? (
              <select name={name} defaultValue={current} className="field-input">
                <option value="">—</option>
                {field.kind === "yes_no" ? (
                  <>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </>
                ) : (
                  <>
                    {field.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                    {/* A choice since taken off the list stays selectable on the
                        records that already hold it, so opening the form and
                        saving does not quietly clear it. */}
                    {current && !field.options.includes(current) && <option value={current}>{current}</option>}
                  </>
                )}
              </select>
            ) : (
              <input
                name={name}
                type={field.kind === "date" ? "date" : "text"}
                inputMode={field.kind === "number" ? "decimal" : undefined}
                maxLength={field.kind === "text" ? MAX_TEXT_VALUE : undefined}
                defaultValue={current}
                className="field-input"
              />
            )}
          </label>
        );
      })}
    </>
  );
}
