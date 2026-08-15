import { mutateTable, readTable } from "./store";

/**
 * Contact activity.
 *
 * The old version was a `{ title, date }[]` baked into each contact, with dates
 * written as literal strings ("23 May 2024, 9:41 AM"). Nothing produced them
 * and nothing could update them — the same defect as meetings storing the word
 * "Today": a rendered label persisted in place of the fact behind it.
 *
 * Here the fact is `at`, an ISO timestamp, and every label is derived from it
 * at read time. Entries are appended by the actions the user actually takes.
 */

const TABLE = "activity";

export const ACTIVITY_KINDS = [
  "note",
  "call",
  "text",
  "email",
  "meeting",
  "deal",
  "revenue",
  "created",
  "updated",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type Activity = {
  id: string;
  contactId: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  /** ISO timestamp — the stored truth. Every label is derived from this. */
  at: string;
  /** Present on revenue entries. */
  amount?: number;
};

/**
 * No seed.
 *
 * The previous fixtures ("Contact activity explained") described events that
 * never happened. An empty history is honest; it fills in as the user works.
 */
const seed: Activity[] = [];

export async function listActivity(): Promise<Activity[]> {
  const rows = await readTable<Activity>(TABLE, seed);
  return [...rows].sort((a, b) => b.at.localeCompare(a.at));
}

export async function listActivityFor(contactId: string): Promise<Activity[]> {
  const rows = await listActivity();
  return rows.filter((a) => a.contactId === contactId);
}

export async function logActivity(input: {
  contactId: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  amount?: number;
}): Promise<Activity> {
  const entry: Activity = {
    id: `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    contactId: input.contactId,
    kind: input.kind,
    title: input.title,
    detail: input.detail?.trim() || undefined,
    amount: input.amount,
    at: new Date().toISOString(),
  };

  await mutateTable<Activity>(TABLE, seed, (rows) => [entry, ...rows]);
  return entry;
}

/**
 * Remove one entry.
 *
 * Scoped to the contact as well as the id: an activity id arriving from the
 * client is forgeable, and without the pairing one contact's panel could delete
 * another's history.
 */
export async function deleteActivity(contactId: string, activityId: string): Promise<void> {
  await mutateTable<Activity>(TABLE, seed, (rows) => {
    if (!rows.some((a) => a.id === activityId && a.contactId === contactId)) return rows;
    return rows.filter((a) => !(a.id === activityId && a.contactId === contactId));
  });
}

/**
 * Drop a contact's history when the contact goes.
 *
 * Without this the rows outlive the record they describe and accumulate
 * forever, invisible and unreachable.
 */
export async function deleteActivityFor(contactId: string): Promise<void> {
  await mutateTable<Activity>(TABLE, seed, (rows) => {
    if (!rows.some((a) => a.contactId === contactId)) return rows;
    return rows.filter((a) => a.contactId !== contactId);
  });
}
