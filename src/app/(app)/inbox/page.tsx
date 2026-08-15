import { listMessages } from "@/server/inbox-repo";
import { listContacts } from "@/server/contacts-repo";
import { listLeads } from "@/server/leads-repo";
import { listPeople } from "@/server/people";
import type { ContactChannel } from "@/components/ui/ChannelBadge";
import { InboxView } from "./InboxView";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const [messages, contacts, leads, people] = await Promise.all([
    listMessages(),
    listContacts(),
    listLeads(),
    listPeople(),
  ]);

  /**
   * Which sender is already a contact.
   *
   * The panel's Note and Revenue buttons act on a contact record, so they can
   * only be offered when the sender actually is one. Matched on email first
   * (unambiguous), then on full name.
   */
  const byEmail = new Map(contacts.filter((c) => c.email).map((c) => [c.email.toLowerCase(), c.id]));
  const byName = new Map(contacts.map((c) => [`${c.firstName} ${c.lastName}`.toLowerCase(), c.id]));

  const contactFor: Record<string, string> = {};
  for (const m of messages) {
    const id = byEmail.get(m.email.toLowerCase()) ?? byName.get(m.name.toLowerCase());
    if (id) contactFor[m.id] = id;
  }

  /**
   * Where each sender came from.
   *
   * The corner badge used to render a field called `channel` whose values were
   * "amber" / "green" / "blue" — colours, not sources. This resolves a real one:
   * the lead's recorded acquisition source when the sender is a known lead, and
   * otherwise the channel the message actually arrived on. Everything in this
   * inbox is email, so that fallback is a fact rather than a placeholder.
   */
  const leadByEmail = new Map(leads.filter((l) => l.email).map((l) => [l.email.toLowerCase(), l.source]));
  const leadByName = new Map(leads.map((l) => [l.name.toLowerCase(), l.source]));

  const channelFor: Record<string, ContactChannel> = {};
  for (const m of messages) {
    channelFor[m.id] =
      leadByEmail.get(m.email.toLowerCase()) ?? leadByName.get(m.name.toLowerCase()) ?? "Email";
  }

  return <InboxView messages={messages} contactFor={contactFor} channelFor={channelFor} people={people} />;
}
