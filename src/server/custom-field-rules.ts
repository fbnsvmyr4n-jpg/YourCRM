/**
 * What a custom field is, with no database.
 *
 * Shared by the server, which validates what a form posted, and the screens,
 * which show a stored value and build the right input for each kind. Plain
 * functions and no imports, so it is safe in the browser bundle.
 *
 * ── The one representation that crosses the wire ─────────────────────────
 *
 * A value travels as a CANONICAL STRING, whatever its kind:
 *
 *   text / choice   as typed (trimmed)
 *   number          a plain decimal, "1250.5" — no grouping, no currency
 *   date            "YYYY-MM-DD", never a Date (a Date is an instant, and an
 *                   instant shifts a calendar day across time zones)
 *   yes_no          "yes" or "no"
 *
 * Absent means not set. One shape means a value can be put straight back into
 * an input's `defaultValue`, and the only place that knows about formatting is
 * `displayValue`.
 */

export const FIELD_ENTITIES = ["contact", "deal"] as const;
export type FieldEntity = (typeof FIELD_ENTITIES)[number];

export const FIELD_KINDS = ["text", "number", "date", "choice", "yes_no"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export const KIND_LABEL: Record<FieldKind, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  choice: "Choice list",
  yes_no: "Yes / no",
};

/** Per kind of record. Past this a form stops being something people fill in. */
export const MAX_FIELDS_PER_ENTITY = 30;
export const MAX_OPTIONS = 30;
export const MAX_LABEL = 60;
export const MAX_OPTION = 60;
export const MAX_TEXT_VALUE = 500;

export type CustomField = {
  id: string;
  entity: FieldEntity;
  label: string;
  kind: FieldKind;
  options: string[];
  archived: boolean;
};

/** fieldId → canonical value, for one record. */
export type FieldValues = Record<string, string>;

/** The form input for a field is named this, so it cannot collide with a real column. */
export const inputName = (fieldId: string) => `cf:${fieldId}`;

const squash = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

/* ------------------------------------------------------------------ */
/* A field somebody defined                                            */
/* ------------------------------------------------------------------ */

/**
 * Choices arrive as one per line, the way a person types a list. Blank lines
 * and repeats (ignoring case) are dropped rather than refused — they are how a
 * pasted list looks, not a mistake worth an error.
 */
export function parseOptions(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const option = squash(line, MAX_OPTION);
    if (!option || seen.has(option.toLowerCase())) continue;
    seen.add(option.toLowerCase());
    out.push(option);
  }
  return out;
}

export function checkDefinition(raw: {
  label: unknown;
  kind: unknown;
  options: unknown;
}): { label: string; kind: FieldKind; options: string[] } | { error: string } {
  const label = squash(raw.label, MAX_LABEL);
  if (!label) return { error: "Give the field a name." };

  const kind = (FIELD_KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as FieldKind) : null;
  if (!kind) return { error: "Choose what kind of field it is." };

  if (kind !== "choice") return { label, kind, options: [] };

  const options = parseOptions(raw.options);
  if (options.length === 0) return { error: "A choice list needs at least one choice — one per line." };
  if (options.length > MAX_OPTIONS) return { error: `A choice list can have up to ${MAX_OPTIONS} choices.` };
  return { label, kind, options };
}

/* ------------------------------------------------------------------ */
/* A value somebody typed                                              */
/* ------------------------------------------------------------------ */

/** Up to 15 digits before the point and 4 after — what the column holds. */
const NUMBER = /^-?\d{1,15}(\.\d{1,4})?$/;

function isRealDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/**
 * Turn what an input posted into a canonical value, `null` for "not set", or a
 * sentence saying what is wrong.
 *
 * Numbers accept the grouping a person types — "12 500", "12,500" — and store
 * the plain figure. A comma is only ever a thousands separator here: accepting
 * it as a decimal point too would make "1,250" mean two different amounts
 * depending on who typed it.
 */
export function parseValue(
  field: Pick<CustomField, "label" | "kind" | "options">,
  raw: unknown
): { value: string | null } | { error: string } {
  const typed = squash(raw, MAX_TEXT_VALUE);
  if (!typed) return { value: null };

  switch (field.kind) {
    case "text":
      return { value: typed };
    case "number": {
      const plain = typed.replace(/[\s,]/g, "");
      if (!NUMBER.test(plain)) return { error: `${field.label} must be a number.` };
      /* Canonical: no leading zeros, no trailing zeros after the point. */
      const [whole, fraction = ""] = plain.replace(/^-/, "").split(".");
      const sign = plain.startsWith("-") ? "-" : "";
      const w = whole.replace(/^0+(?=\d)/, "");
      const f = fraction.replace(/0+$/, "");
      const value = `${sign}${w}${f ? `.${f}` : ""}`;
      return { value: value === "-0" ? "0" : value };
    }
    case "date":
      return isRealDate(typed) ? { value: typed } : { error: `${field.label} must be a date.` };
    case "choice": {
      /* Matched ignoring case, stored in the field's own spelling. */
      const match = field.options.find((o) => o.toLowerCase() === typed.toLowerCase());
      return match ? { value: match } : { error: `${typed} is not one of the choices for ${field.label}.` };
    }
    case "yes_no": {
      const v = typed.toLowerCase();
      if (v === "yes" || v === "no") return { value: v };
      return { error: `${field.label} must be yes or no.` };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Showing a value                                                     */
/* ------------------------------------------------------------------ */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A stored value as a person reads it.
 *
 * Formatted by hand rather than with `Intl`, so the server and the browser
 * produce the identical string — a date rendered twice by two different
 * locales is a hydration mismatch.
 */
export function displayValue(kind: FieldKind, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  switch (kind) {
    case "date": {
      const [y, m, d] = value.split("-");
      return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ""} ${y}`;
    }
    case "yes_no":
      return value === "yes" ? "Yes" : "No";
    case "number": {
      const [whole, fraction] = value.replace(/^-/, "").split(".");
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return `${value.startsWith("-") ? "−" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
    }
    default:
      return value;
  }
}
