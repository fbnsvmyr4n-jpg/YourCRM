import { listMessages } from "@/server/repos/inbox";
import { listContacts } from "@/server/repos/contacts";
import { listDeals } from "@/server/repos/deals";
import { decorateMessage } from "@/server/decorate-message";
import { withCurrentTenant } from "@/server/tenant-session";
import type { ContactChannel } from "@/components/ui/ChannelBadge";
import { InboxView } from "./InboxView";

export const dynamic = "force-dynamic";

/** The source values the badge understands, mapped from what the deal stores. */
const SOURCE_LABEL: Record<string, ContactChannel> = {
  google_ads: "Google Ads",
  facebook: "Facebook",
  referral: "Referral",
  phone_call: "Phone Call",
};

export default async function InboxPage() {
  const { messages, contactFor, channelFor, people } = await withCurrentTenant(async (q) => {
    // Trash is a folder, so the page reads every message and lets the view
    // filter — the repo's folder predicates back the counts and the tabs.
    const [inbox, sent, trash] = [
      await listMessages(q, "inbox"),
      await listMessages(q, "sent"),
      await listMessages(q, "trash"),
    ];
    const contacts = await listContacts(q);
    const deals = await listDeals(q);

    const senders = contacts.map((c) => ({
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      email: c.email,
      phone: c.phone,
      info: c.info,
      location: c.location,
    }));

    const rows = [...inbox, ...sent, ...trash];

    /**
     * Which sender is already a contact.
     *
     * This used to be two maps and a fallback chain, matching senders to
     * contacts on email and then on name. The message carries the contact's id
     * now, so the question answers itself — and a renamed contact no longer
     * loses their mail.
     */
    const contactFor: Record<string, string> = {};
    for (const m of rows) if (m.contactId) contactFor[m.id] = m.contactId;

    /**
     * Where each sender came from.
     *
     * The badge showed a field called `channel` whose values were "amber" and
     * "green" — colours, not sources. This resolves a real one: the source
     * recorded on that person's earliest deal, which is a stored fact rather
     * than a name match. Everything here arrives by email, so that fallback is
     * true rather than a placeholder.
     */
    const sourceByContact = new Map<string, string>();
    for (const d of [...deals].reverse()) {
      if (d.contactId) sourceByContact.set(d.contactId, d.source);
    }

    const channelFor: Record<string, ContactChannel> = {};
    for (const m of rows) {
      const source = m.contactId ? sourceByContact.get(m.contactId) : undefined;
      channelFor[m.id] = (source && SOURCE_LABEL[source]) || "Email";
    }

    return {
      messages: rows.map((m) => decorateMessage(m, senders)),
      contactFor,
      channelFor,
      people: senders.map((s) => ({ name: s.name, company: s.info ?? "", email: s.email ?? "" })),
    };
  });

  return (
    <InboxView messages={messages} contactFor={contactFor} channelFor={channelFor} people={people} />
  );
}
