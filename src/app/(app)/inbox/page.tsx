import { listMessages, purgeExpiredMessages } from "@/server/repos/inbox";
import { listContacts } from "@/server/repos/contacts";
import { listDeals } from "@/server/repos/deals";
import { decorateMessage } from "@/server/decorate-message";
import { withTenantPage } from "@/server/tenant-session";
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
  const { messages, contactFor, channelFor, people, recent } = await withTenantPage(async (q) => {
    /* Before reading, so nothing expired is listed and then vanishes on the
       next load. There is no scheduler in this app; the bin is emptied by
       whoever opens the inbox next, which for an account in use is often
       enough, and for one that is not, harms nobody. */
    await purgeExpiredMessages(q);

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

    /**
     * Who has been written to or heard from most recently.
     *
     * A real signal rather than a guess: the newest message carrying each
     * contact's id, read from the mail already on this page. It orders the
     * whole address book, so an ambiguous query lands on the person actually
     * being corresponded with, and it supplies the short list the To field
     * offers before anything has been typed.
     *
     * Contacts with no mail keep their existing order behind the ones that
     * have it — they are still findable by typing, just not proposed as
     * "recent", which for them would be false.
     */
    const lastMessageAt = new Map<string, number>();
    for (const m of rows) {
      if (!m.contactId || !m.sentAt) continue;
      const at = new Date(m.sentAt).getTime();
      if (Number.isNaN(at)) continue;
      const seen = lastMessageAt.get(m.contactId);
      if (seen === undefined || at > seen) lastMessageAt.set(m.contactId, at);
    }

    const ordered = [...senders]
      .map((s, i) => ({ s, i, at: lastMessageAt.get(s.id) }))
      .sort((a, b) => {
        if (a.at !== undefined && b.at !== undefined) return b.at - a.at;
        /* Anyone messaged outranks anyone not, whatever the list order. */
        if (a.at !== undefined) return -1;
        if (b.at !== undefined) return 1;
        return a.i - b.i;
      });

    const asPerson = (s: (typeof senders)[number]) => ({
      name: s.name,
      company: s.info ?? "",
      email: s.email ?? "",
    });

    const addressBook = ordered.map(({ s }) => asPerson(s));
    /* Only people there is actually a message with, and only those reachable —
       proposing someone with no address produces a mail that cannot be sent. */
    const recentPeople = ordered
      .filter(({ at, s }) => at !== undefined && s.email)
      .map(({ s }) => asPerson(s));

    return {
      messages: rows.map((m) => decorateMessage(m, senders)),
      contactFor,
      channelFor,
      people: addressBook,
      recent: recentPeople,
    };
  });

  return (
    <InboxView
      messages={messages}
      contactFor={contactFor}
      channelFor={channelFor}
      people={people}
      recent={recent}
    />
  );
}
