import { mutateTable, readTable } from "./store";

const TABLE = "settings";

/**
 * Workspace-level settings.
 *
 * These were hardcoded constants read by the Leads and Meetings pages
 * (`MONTHLY_TARGET`, `WEEKLY_CAPACITY`). A number the product presents as *your*
 * target should be yours to set — so they live here, persisted through the same
 * store seam as everything else.
 *
 * Stored as a single row so the collection stays a plain array like every other
 * table; `SETTINGS_ID` is the only key that is ever read or written.
 */
const SETTINGS_ID = "workspace";

export type Settings = {
  id: string;
  /** Revenue goal for the current month, in whole currency units. */
  monthlyTarget: number;
  /** How many meetings a week the team considers a full load. */
  weeklyCapacity: number;
};

export const DEFAULT_SETTINGS: Settings = {
  id: SETTINGS_ID,
  monthlyTarget: 50_000,
  weeklyCapacity: 20,
};

const seed: Settings[] = [DEFAULT_SETTINGS];

export async function getSettings(): Promise<Settings> {
  const rows = await readTable<Settings>(TABLE, seed);
  const found = rows.find((s) => s.id === SETTINGS_ID);
  // Merge over the defaults so a settings row written before a field existed
  // doesn't leave that field undefined and break arithmetic downstream.
  return { ...DEFAULT_SETTINGS, ...found, id: SETTINGS_ID };
}

/** Patch settings atomically. Only the keys provided are changed. */
export async function updateSettings(
  patch: Partial<Omit<Settings, "id">>
): Promise<Settings> {
  let result = DEFAULT_SETTINGS;
  await mutateTable<Settings>(TABLE, seed, (rows) => {
    const idx = rows.findIndex((s) => s.id === SETTINGS_ID);
    const current = idx === -1 ? DEFAULT_SETTINGS : { ...DEFAULT_SETTINGS, ...rows[idx] };
    result = { ...current, ...patch, id: SETTINGS_ID };

    const next = [...rows];
    if (idx === -1) next.push(result);
    else next[idx] = result;
    return next;
  });
  return result;
}
