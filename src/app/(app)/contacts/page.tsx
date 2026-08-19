import { listContacts } from "@/server/repos/contacts";
import { listUsers } from "@/server/repos/users";
import { contactSummaries } from "@/server/contact-summaries";
import { withSystem } from "@/server/tenant";
import { requireTenantPage, withTenantPage } from "@/server/tenant-session";
import { ContactsView, decorate } from "./ContactsView";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  // One tenant context for the whole page: the contacts and their summaries are
  // read in the same transaction, so the panel cannot show a timeline for a
  // record the list no longer contains.
  const ctx = await requireTenantPage();

  // Colleagues, so an owner can be shown by name rather than by id. Read
  // through the system path because users are agency-level, not tenant-level.
  const people = await withSystem((q) => listUsers(q, ctx.agencyId));

  const { contacts, summaries } = await withTenantPage(async (q) => {
    const rows = await listContacts(q);
    return {
      contacts: rows.map((c) => decorate(c, people)),
      summaries: await contactSummaries(q, rows.map((c) => c.id)),
    };
  });

  return (
    <ContactsView
      contacts={contacts}
      summaries={summaries}
      currentUserId={ctx.userId}
      people={people.map((p) => ({ id: p.id, name: p.name }))}
    />
  );
}
