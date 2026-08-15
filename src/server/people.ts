import { listContacts } from "./contacts-repo";
import { listLeads } from "./leads-repo";
import type { Person } from "@/components/ui/PersonField";

/**
 * Everyone the CRM can offer as a suggestion.
 *
 * Contacts and leads both, because you often write to — or book with — someone
 * who hasn't become a contact yet. Deduplicated by name so a person recorded in
 * both places doesn't appear twice, contact first because that record is the
 * fuller one.
 *
 * Lives here rather than in a page so the meeting scheduler and the inbox
 * composer offer the *same* people. It was built inline in the meetings page
 * first; a second copy in the inbox would have been free to drift.
 */
export async function listPeople(): Promise<Person[]> {
  const [contacts, leads] = await Promise.all([listContacts(), listLeads()]);

  const people = new Map<string, Person>();
  for (const c of contacts) {
    const name = `${c.firstName} ${c.lastName}`.trim();
    if (name) people.set(name.toLowerCase(), { name, company: c.company, email: c.email });
  }
  for (const l of leads) {
    const key = l.name.trim().toLowerCase();
    if (l.name && !people.has(key)) {
      people.set(key, { name: l.name, company: l.company, email: l.email });
    }
  }

  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}
