import type { AvatarColor } from "@/components/ui/Avatar";
import type { ContactRecord } from "./repos/contacts";

/**
 * Turning a contact record into what the screen shows.
 *
 * Server-safe, and that is the point. It used to live in `ContactsView.tsx`,
 * which carries "use client", so the contacts page — a server component —
 * imported a function out of a client module and called it. Next refused with
 * "Attempted to call decorate() from the server", and the page rendered its
 * error boundary. `decorateDeal` had exactly the same shape; a guard now fails
 * on any server file importing a callable from a client module.
 */

export type ContactType = "lead" | "client";

export type Contact = Omit<ContactRecord, "email" | "phone" | "location" | "info"> & {
  /**
   * Nullable in the database, never null here.
   *
   * The columns are genuinely optional — plenty of contacts have no phone
   * number — but a screen renders text, and threading `| null` through forty
   * JSX expressions buys nothing. Flattened once, at the boundary.
   */
  email: string;
  phone: string;
  location: string;
  initials: string;
  color: AvatarColor;
  type: ContactType;
  status: string;
  /** The old `company` and `companyInfo` both read from this one column now. */
  info: string;
  company: string;
  companyInfo: string;
  owner: string;
};

const AVATAR_COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

/** Stable per contact: the same person keeps the same colour between renders. */
function paletteFor(id: string): AvatarColor {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function decorate(c: ContactRecord, people: { id: string; name: string }[]): Contact {
  const first = c.firstName.trim();
  const last = c.lastName.trim();
  return {
    ...c,
    email: c.email ?? "",
    info: c.info ?? "",
    phone: c.phone ?? "",
    location: c.location ?? "",
    initials: ((first[0] ?? "") + (last[0] ?? "") || first.slice(0, 2)).toUpperCase(),
    color: paletteFor(c.id),
    // Derived from deals, which is the whole point: somebody is a client
    // because they bought something, not because a dropdown says so.
    type: c.isClient ? "client" : "lead",
    status: c.isClient ? "Client" : c.hasOpenDeal ? "In progress" : "No open deal",
    company: c.info ?? "",
    companyInfo: c.info ?? "",
    owner: people.find((p) => p.id === c.ownerUserId)?.name ?? "Unassigned",
  };
}
