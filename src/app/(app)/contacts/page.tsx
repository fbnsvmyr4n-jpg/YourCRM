import { listCompanies } from "@/server/repos/companies";
import { listContacts } from "@/server/repos/contacts";
import { listFields, valuesFor } from "@/server/repos/custom-fields";
import { assignableTeam } from "@/server/repos/automations";
import { getSettings } from "@/server/repos/settings";
import { listTodos } from "@/server/repos/todos";
import { listUsers } from "@/server/repos/users";
import { listTags, listViews, tagIdsByContact } from "@/server/repos/tags";
import { roleCan } from "@/server/permissions";
import { contactSummaries } from "@/server/contact-summaries";
import { withSystem } from "@/server/tenant";
import { requireTenantPage, withTenantPage } from "@/server/tenant-session";
import { decorate } from "@/server/decorate-contact";
import { instantToWallClock } from "@/lib/zoned";
import type { Todo } from "@/server/todo-rules";
import { ContactsView } from "./ContactsView";

export const dynamic = "force-dynamic";

export default async function ContactsPage({
  searchParams,
}: {
  /** `?c=<id>` opens that person — how a task, a search result or a link elsewhere lands on them. */
  searchParams: Promise<{ c?: string }>;
}) {
  const { c: requested } = await searchParams;
  // One tenant context for the whole page: the contacts and their summaries are
  // read in the same transaction, so the panel cannot show a timeline for a
  // record the list no longer contains.
  const ctx = await requireTenantPage();

  // Colleagues, so an owner can be shown by name rather than by id. Read
  // through the system path because users are agency-level, not tenant-level.
  const people = await withSystem((q) => listUsers(q, ctx.agencyId));

  const { contacts, summaries, companies, customFields, customValues, tasksByContact, team, today, tags, tagIds, views } =
    await withTenantPage(async (q) => {
      const rows = await listContacts(q);
      const settings = await getSettings(q);
      /* Open tasks about a person, grouped by who they are about. One read for
         the whole list; finished ones stay on the Tasks page. */
      const tasksByContact: Record<string, Todo[]> = {};
      for (const t of await listTodos(q)) {
        if (t.contactId && !t.doneAt) (tasksByContact[t.contactId] ??= []).push(t);
      }
      /* Labels, who carries which, and the saved views over them — three
         statements for the whole list. A view naming a tag deleted since
         opens showing what it still can. */
      const tags = await listTags(q);
      const views = await listViews(q, new Set(tags.map((t) => t.id)));
      return {
        tags,
        views,
        tagIds: await tagIdsByContact(q),
        /* The workspace's own fields and every contact's values for them, in two
           statements for the whole list rather than one per person opened. */
        customFields: await listFields(q, "contact"),
        customValues: await valuesFor(q, "contact", rows.map((c) => c.id)),
        contacts: rows.map((c) => decorate(c, people)),
        summaries: await contactSummaries(q, rows.map((c) => c.id)),
        // For the bulk "move to company" action. Read in the same transaction,
        // so the list cannot offer a company the same request would not find.
        companies: await listCompanies(q),
        tasksByContact,
        team: await assignableTeam(q),
        today:
          instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
          new Date().toISOString().slice(0, 10),
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
      initialContactId={requested && contacts.some((c) => c.id === requested) ? requested : undefined}
      tasksByContact={tasksByContact}
      team={team}
      today={today}
      tags={tags}
      tagIdsByContact={tagIds}
      views={views}
      canManageTags={roleCan(ctx.role, "manage_users")}
    />
  );
}
