/**
 * What a draft IS, and when one is worth keeping — the parts both sides share.
 *
 * Its own module for the same reason `data/payment-methods.ts` is: the composer
 * runs in the browser and has to make the same judgement the server makes, and
 * importing that judgement from `repos/drafts` would pull `node:crypto` into
 * the browser bundle. That failure does not show up in type-checking or in the
 * build — it shows up as a blank page at run time, which is exactly how it was
 * found the first time.
 *
 * So anything both sides need lives here: no imports, no database, no secrets.
 */

export type Draft = {
  id: string;
  to: string;
  subject: string;
  body: string;
  /** When it was last written to, so the list can lead with the newest. */
  updatedAt: string;
};

/**
 * Is there anything here worth keeping?
 *
 * A recipient ALONE does not count. Pressing Email on a contact card fills in
 * the address and nothing else, so counting that as a draft would mean every
 * abandoned click left a row in the folder — and Drafts would fill with empty
 * messages addressed to people nobody ever wrote to. Writing is a subject or a
 * body; an address is an intention.
 *
 * One definition, used by the composer before it asks and by the repository
 * before it writes. Two would mean a box that promises to save and a server
 * that quietly does not.
 */
export function worthKeeping(draft: { subject?: string; body?: string }): boolean {
  return Boolean(draft.subject?.trim() || draft.body?.trim());
}
