import type { AvatarColor } from "@/components/ui/Avatar";

export type MsgFolder = "unread" | "assigned" | "sent" | "received" | "trash";

/** Allowed values first, types derived — see the note in `data/contacts.ts`. */
export const MSG_CATEGORIES = [
  "Appointments",
  "Tasks",
  "Meeting Requests",
  "Follow-ups",
  "Enquiries",
] as const;
export type MsgCategory = (typeof MSG_CATEGORIES)[number];

export const ATTACHMENT_KINDS = ["pdf", "doc", "txt"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export type Attachment = {
  name: string;
  size: string;
  kind: AttachmentKind;
  /**
   * The document's text.
   *
   * Attachments used to be name-and-size only, so there was nothing behind the
   * card to open — clicking one could never do anything. When this is present
   * the file opens in the viewer and the assistant can summarise it; when it is
   * absent the card says so rather than pretending.
   */
  content?: string;
};

export type Message = {
  id: string;
  initials: string;
  color: AvatarColor;
  name: string;
  role: string;
  company: string;
  subject: string;
  preview: string;
  unread: boolean;
  assigned: boolean;
  direction: "sent" | "received";
  trashed: boolean;
  body: string[];
  attachments: Attachment[];
  email: string;
  phone: string;
  language: string;
  /**
   * ISO timestamp — the stored truth.
   *
   * Replaces `time: "10:31"`, `ago: "2m ago"`, `localTime`, `firstInteraction`
   * and `latestInteraction`, every one of which was a finished string that
   * nothing recomputed. A message stayed "2m ago" forever, and the "local time"
   * was a literal rather than anything to do with the client's clock.
   */
  at: string;
  /** Drives the category chips. Derived on read when absent. */
  category?: MsgCategory;
  /** The client's real business location. */
  location?: string;
  /** IANA zone, e.g. "Africa/Johannesburg" — their current time is computed from it. */
  timeZone?: string;
};

/**
 * Seed fixtures.
 *
 * Timestamps are anchored to when the store is first written so the demo reads
 * sensibly, and are frozen from that point on — exactly like real messages.
 */


export const inboxFilters = [
  "All",
  "Unread",
  "Assigned to me",
  "Sent",
  "Received",
  "Trash",
] as const;
export type InboxFilter = (typeof inboxFilters)[number];
