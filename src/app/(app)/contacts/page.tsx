import { listContacts } from "@/server/contacts-repo";
import { contactSummaries } from "@/server/contact-timeline";
import { getCurrentUser } from "@/server/session";
import { ContactsView } from "./ContactsView";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const contacts = await listContacts();
  const [summaries, user] = await Promise.all([contactSummaries(contacts), getCurrentUser()]);

  return <ContactsView contacts={contacts} summaries={summaries} currentUser={user?.name ?? null} />;
}
