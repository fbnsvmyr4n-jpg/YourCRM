/**
 * Runtime validation for the server-action boundary.
 *
 * A "use server" function is a public POST endpoint. TypeScript is erased at
 * runtime, so `String(formData.get("stage")) as StageId` checks nothing — an
 * arbitrary value goes straight into the database. That is not theoretical:
 * one deal stored with an unknown stage renders in no column (invisible and
 * therefore impossible to delete through the UI) while still counting toward
 * "Total Deals", and turns Weighted Forecast into a literal "$NaN" because
 * `WEIGHTS[stage]` is undefined.
 *
 * Everything crossing the boundary is checked here. The enum lists these
 * validate against are exported from `src/data/*`, where the union types are
 * derived from the same arrays — so a new stage or status can't be added to
 * the type without the validator learning about it too.
 */

/** Upper bound on a single money field. Guards against absurd/overflowing input. */
const MAX_MONEY = 1_000_000_000;

/**
 * A single-line string: trimmed, internal whitespace collapsed, length-capped.
 * The cap matters because each collection is stored as one JSON document — an
 * unbounded field would bloat every read of that whole collection.
 */
export function text(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Like `text`, but newlines are meaningful (message bodies, summaries).
 * Runs of spaces/tabs collapse to one, and each line is trimmed so no stray
 * space survives at a line ending.
 */
export function multiline(value: unknown, max = 5000): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim()
    .slice(0, max);
}

/**
 * Returns the value only when it is one of `allowed`, otherwise null.
 * Callers must treat null as "reject this write" — never as "use a default",
 * unless the field genuinely has a safe default (see `pickOr`).
 */
export function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  const v = typeof value === "string" ? value.trim() : "";
  return (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/**
 * Same as `pick`, but falls back to a default. Only for fields where an
 * invalid value is harmless and a default is genuinely correct — e.g. a form
 * select the user left untouched. Never use it for a field that decides where
 * a record lives, such as a deal's stage.
 */
export function pickOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return pick(value, allowed) ?? fallback;
}

/**
 * A non-negative, finite money amount. Returns null for NaN/Infinity/negative
 * input so the caller can reject rather than persist a poisoned number.
 * An empty field means "not specified" and is treated as 0.
 */
export function money(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) return null;
  return Math.round(n);
}

/** A non-negative, finite integer (durations, counts). Null when unusable. */
export function count(value: unknown, max = 1_000_000): number | null {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.round(n);
}

/**
 * A record id arriving from the client. Ids we generate are slug-ish, so a
 * conservative character set is safe and keeps anything odd out of the store.
 */
export function id(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.length > 100 || !/^[A-Za-z0-9._-]+$/.test(v)) return null;
  return v;
}

/**
 * An optional email. Empty is allowed (the Voice Agent creates leads from a
 * phone call with no email yet); anything present must at least look like an
 * address. Deliberately loose — over-strict email regexes reject valid ones.
 */
export function email(value: unknown, max = 254): string | null {
  const v = text(value, max);
  if (!v) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v.toLowerCase() : null;
}
