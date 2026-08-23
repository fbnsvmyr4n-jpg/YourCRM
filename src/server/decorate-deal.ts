import type { AvatarColor } from "@/components/ui/Avatar";
import type { DealRecord } from "./repos/deals";

/**
 * Turning a deal record into what a card shows.
 *
 * Server-safe, and that is the whole reason it lives here. It used to be
 * exported from `DealsBoard.tsx`, which carries "use client" — so the deals
 * page, a server component, was importing a function out of a client module
 * and calling it. Next refused: "Attempted to call decorateDeal() from the
 * server but decorateDeal is on the client", and the page rendered its error
 * boundary. Every other entity already had a `decorate-*.ts`; deals was the one
 * that did not.
 */

/**
 * A deal, decorated with what the card shows and the record does not store.
 *
 * `contact`, `company`, `initials` and `color` were columns on the old deal —
 * a copy of the person's details sitting on the opportunity, which is how they
 * drifted apart from the contact record. The link is a foreign key now, so the
 * name is looked up rather than duplicated.
 *
 * Money stays in cents all the way to the formatter. Converting on the way in
 * and again on the way out is how a figure ends up 100× wrong.
 */
export type Deal = DealRecord & {
  contact: string;
  company: string;
  initials: string;
  color: AvatarColor;
  /** Whole-unit value for display only; the source of truth is `valueCents`. */
  value: number;
  splitTotal?: number;
  closeDate: string;
};

const AVATAR_COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

function paletteFor(id: string): AvatarColor {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function decorateDeal(
  d: DealRecord,
  contacts: { id: string; name: string; info: string | null }[]
): Deal {
  const person = contacts.find((c) => c.id === d.contactId);
  const name = person?.name ?? "";
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    ...d,
    contact: name,
    company: person?.info ?? "",
    initials: ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "—",
    color: paletteFor(d.id),
    value: d.valueCents / 100,
    splitTotal: d.splitTotalCents == null ? undefined : d.splitTotalCents / 100,
    // The close date the old model stored was an expectation nobody read.
    // What is shown now is the date the deal actually closed, or nothing.
    closeDate: d.wonAt ? new Date(d.wonAt).toLocaleDateString() : "",
  };
}
