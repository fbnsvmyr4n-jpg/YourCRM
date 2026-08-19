import { createContact, listContacts } from "./repos/contacts";
import type { TenantQuery } from "./tenant";

/**
 * Turn a typed name into a real contact.
 *
 * Meetings, calls and messages all link to a contact by id now. The forms that
 * create them ask for a name, because that is what somebody types when booking
 * a call. Something has to bridge the two, and the bridge is where duplicates
 * get created if it is careless.
 *
 * Lives above the repositories rather than inside one: it reads contacts and
 * may write one, on behalf of a different entity entirely.
 *
 * The matching rule is the same as the migration's, for the same reason. An
 * exact email match is trusted because an address identifies a person. A name
 * is only trusted when it is unambiguous AND no email contradicts it — two
 * people share a name often enough that a loose match would fold one person's
 * history into another's, and nothing would say it had happened. A duplicate is
 * visible and fixable; a wrong merge is neither.
 */
export async function linkContactByName(
  q: TenantQuery,
  name: string,
  email?: string | null
): Promise<string | null> {
  const wanted = name.trim();
  if (!wanted) return null;

  const normalisedEmail = (email ?? "").trim().toLowerCase();
  const contacts = await listContacts(q);

  if (normalisedEmail) {
    const byEmail = contacts.filter((c) => (c.email ?? "").toLowerCase() === normalisedEmail);
    // Exactly one is a match. More than one is itself a duplicate, and picking
    // between them would be a coin toss.
    if (byEmail.length === 1) return byEmail[0].id;
    if (byEmail.length > 1) return null;
  }

  const wantedName = wanted.toLowerCase().replace(/\s+/g, " ");
  const byName = contacts.filter(
    (c) => `${c.firstName} ${c.lastName}`.trim().toLowerCase() === wantedName
  );
  if (byName.length === 1) {
    const candidate = byName[0];
    // An email that actively disagrees means these are different people who
    // happen to share a name.
    if (normalisedEmail && candidate.email && candidate.email.toLowerCase() !== normalisedEmail) {
      // Fall through and create a new contact rather than merging them.
    } else {
      return candidate.id;
    }
  } else if (byName.length > 1) {
    return null;
  }

  // Nobody matched. Booking a meeting with someone makes them a contact —
  // which is better than the old model, where the name sat on the meeting as
  // a loose string that belonged to no record at all.
  const parts = wanted.split(/\s+/);
  const created = await createContact(q, {
    firstName: parts[0] ?? wanted,
    lastName: parts.slice(1).join(" "),
    email: normalisedEmail || null,
    ownerUserId: q.ctx.userId,
  });
  return created.id;
}
