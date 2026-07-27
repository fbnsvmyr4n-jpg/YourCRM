import { listContacts } from "@/server/contacts-repo";
import { ContactsView } from "./ContactsView";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const contacts = await listContacts();
  return <ContactsView contacts={contacts} />;
}
