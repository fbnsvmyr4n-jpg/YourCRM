/**
 * Which contacts a filter keeps, with no database.
 *
 * Shared by the contacts screen, which filters as the reader clicks, and the
 * server, which checks a saved view's shape before storing it and again when
 * reading one back — a view saved by an older build, or pointing at a tag
 * since deleted, must still open rather than break the page.
 */

export const TAG_COLORS = ["blue", "green", "amber", "red", "purple", "teal", "pink", "slate"] as const;
export type TagColor = (typeof TAG_COLORS)[number];

/** The palette each tag colour draws from, as theme tokens. */
export const TAG_TONE: Record<TagColor, { color: string; soft: string }> = {
  blue: { color: "var(--accent)", soft: "var(--accent-soft)" },
  green: { color: "var(--green)", soft: "var(--green-soft)" },
  amber: { color: "var(--amber)", soft: "var(--amber-soft)" },
  red: { color: "var(--red)", soft: "var(--red-soft)" },
  purple: { color: "var(--purple)", soft: "var(--purple-soft)" },
  teal: { color: "#0d9488", soft: "rgba(13,148,136,0.14)" },
  pink: { color: "#db2777", soft: "rgba(219,39,119,0.12)" },
  slate: { color: "var(--text-muted)", soft: "var(--rule-soft)" },
};

export const MAX_TAG_NAME = 40;
export const MAX_VIEW_NAME = 60;
/** Per workspace. A tag list past this is a taxonomy nobody can scan. */
export const MAX_TAGS = 100;
export const MAX_VIEWS = 30;

export type Tag = { id: string; name: string; color: TagColor; contacts: number };

export const CONTACT_TYPES = ["all", "client", "lead"] as const;
export type ContactTypeFilter = (typeof CONTACT_TYPES)[number];

export type ContactFilter = {
  type: ContactTypeFilter;
  tagIds: string[];
  /** "any": has at least one of the tags. "all": has every one. */
  match: "any" | "all";
};

export const EMPTY_FILTER: ContactFilter = { type: "all", tagIds: [], match: "any" };

/** `createdBy` decides who may delete it: its author, or whoever manages the team. */
export type SavedView = { id: string; name: string; filter: ContactFilter; createdBy: string | null };

export function isEmptyFilter(f: ContactFilter): boolean {
  return f.type === "all" && f.tagIds.length === 0;
}

/**
 * A filter from anything — a posted form, a JSON column — made safe.
 *
 * Unknown values fall back to "everything" rather than being refused, and tag
 * ids that no longer exist are dropped when `knownTagIds` is given: a view
 * that named a deleted tag still opens, showing what it still can.
 */
export function parseFilter(raw: unknown, knownTagIds?: ReadonlySet<string>): ContactFilter {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const type = (CONTACT_TYPES as readonly unknown[]).includes(obj.type) ? (obj.type as ContactTypeFilter) : "all";
  const match = obj.match === "all" ? "all" : "any";
  const tagIds = Array.isArray(obj.tagIds)
    ? [...new Set(obj.tagIds.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 80))]
        .filter((t) => !knownTagIds || knownTagIds.has(t))
        .slice(0, 20)
    : [];
  return { type, tagIds, match };
}

export function matchesFilter(contact: { type: "client" | "lead"; tagIds: readonly string[] }, filter: ContactFilter): boolean {
  if (filter.type !== "all" && contact.type !== filter.type) return false;
  if (filter.tagIds.length === 0) return true;
  const has = new Set(contact.tagIds);
  return filter.match === "all" ? filter.tagIds.every((t) => has.has(t)) : filter.tagIds.some((t) => has.has(t));
}

/** "Leads tagged Cape Town or Decision maker". */
export function describeFilter(filter: ContactFilter, tagName: (id: string) => string | undefined): string {
  const who = filter.type === "client" ? "Clients" : filter.type === "lead" ? "Leads" : "Contacts";
  const names = filter.tagIds.map((id) => tagName(id)).filter((n): n is string => Boolean(n));
  if (names.length === 0) return filter.type === "all" ? "All contacts" : `${who} only`;
  const joined =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} ${filter.match === "all" ? "and" : "or"} ${names[names.length - 1]}`;
  return `${who} tagged ${joined}`;
}

export function cleanName(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "";
}
