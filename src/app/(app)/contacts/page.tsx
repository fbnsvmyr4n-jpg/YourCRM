import { listCompanies } from "@/server/repos/companies";
import { listContacts } from "@/server/repos/contacts";
import { listFields, valuesFor } from "@/server/repos/custom-fields";
import { listUsers } from "@/server/repos/users";
import { contactSummaries } from "@/server/contact-summaries";
import { withSystem } from "@/server/tenant";
import { requireTenantPage, withTenantPage } from "@/server/tenant-session";
import { decorate } from "@/server/decorate-contact";
import { ContactsView,  } from "./ContactsView";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  // One tenant context for the whole page: the contacts and their summaries are
  // read in the same transaction, so the panel cannot show a timeline for a
  // record the list no longer contains.
  const ctx = await requireTenantPage();

  // Colleagues, so an owner can be shown by name rather than by id. Read
  // through the system path because users are agency-level, not tenant-level.
  const people = await withSystem((q) => listUsers(q, ctx.agencyId));

  const { contacts, summaries, companies, customFields, customValues } = await withTenantPage(async (q) => {
    const rows = await listContacts(q);
    return {
      /* The workspace's own fields and every contact's values for them, in two
         statements for the whole list rather than one per person opened. */
      customFields: await listFields(q, "contact"),
      customValues: await valuesFor(q, "contact", rows.map((c) => c.id)),
      contacts: rows.map((c) => decorate(c, people)),
      summaries: await contactSummaries(q, rows.map((c) => c.id)),
      // For the bulk "move to company" action. Read in the same transaction,
      // so the list cannot offer a company the same request would not find.
      companies: await listCompanies(q),
    };
  });

  return (
    <ContactsView
      contacts={contacts}
      summaries={summaries}
      currentUserId={ctx.userId}
      people={people.map((p) => ({ id: p.id, name: p.name }))}
      companies={companies.map((c) => ({ id: c.id, name: c.name }))}
      customFields={customFields}
      customValues={customValues}
    />
  );
}
