/**
 * The six areas of Settings, in the order they are offered.
 *
 * In a module of its own, with no `"use client"`, because BOTH sides need it:
 * the server validates `?s=` against this list, and the client renders the rail
 * from it.
 *
 * That is not tidiness. Exporting it from the client component and importing it
 * into the page type-checked perfectly and then failed at runtime with
 * `SECTION_IDS.includes is not a function` — across the boundary a server
 * component receives a reference to the client module, not its values. The
 * shared constant has to live somewhere neither side owns.
 */
export const SECTION_IDS = [
  "account",
  "team",
  "workspaces",
  "preferences",
  "billing",
  "data",
] as const;

export type SettingsSectionId = (typeof SECTION_IDS)[number];

/** Falls back to Account rather than rendering nothing for an unknown value. */
export function sectionFromParam(value: string | undefined): SettingsSectionId {
  return (SECTION_IDS as readonly string[]).includes(value ?? "")
    ? (value as SettingsSectionId)
    : "account";
}
