import type { MessageRecord } from "./repos/inbox";
import type { Message } from "@/data/inbox";
import type { AvatarColor } from "@/components/ui/Avatar";

/**
 * A stored message, shaped for the inbox screen.
 *
 * The record keeps what a message IS: who it is from, what it says, when it
 * arrived, whether it has been read. Everything the old row also carried —
 * the sender's phone number, company, initials, avatar colour — was a copy of
 * the contact's details frozen at the moment the mail landed, which is why a
 * contact who changed jobs still showed their old company in the inbox.
 *
 * Those come from the contact record now, through the foreign key.
 */

const AVATAR_COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

function paletteFor(id: string): AvatarColor {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export type MessagePerson = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  info: string | null;
  location: string | null;
};

export function decorateMessage(m: MessageRecord, people: MessagePerson[]): Message {
  const person = people.find((p) => p.id === m.contactId);
  const name = person?.name ?? "Unknown sender";
  const parts = name.split(/\s+/).filter(Boolean);
  // The body is one column; the screen wants paragraphs, split the same way
  // the classifier splits them so both agree about what a paragraph is.
  const paragraphs = m.body ? m.body.split(/\n\n+/) : [];

  return {
    id: m.id,
    contactId: m.contactId,
    initials: ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?",
    color: paletteFor(m.id),
    name,
    // Never stored, never displayed, and inventing one would be fabrication.
    role: "",
    company: person?.info ?? "",
    subject: m.subject || "(no subject)",
    // Recomputed rather than stored, so editing a body cannot leave a preview
    // quoting text that is no longer there.
    preview: paragraphs[0]?.slice(0, 160) ?? "",
    unread: m.unread,
    // A folder nothing could ever assign to anybody. Kept false rather than
    // removed from the type, which would ripple through the whole view.
    assigned: false,
    direction: m.direction,
    trashed: m.deletedAt !== null,
    body: paragraphs,
    // There is no attachment storage yet. An empty list is the truth; a
    // fabricated one would be the same class of lie as the phantom lead.
    attachments: [],
    email: person?.email ?? "",
    phone: person?.phone ?? "",
    language: "",
    at: m.sentAt,
    category: m.category ?? undefined,
    location: person?.location ?? undefined,
    timeZone: undefined,
  };
}
