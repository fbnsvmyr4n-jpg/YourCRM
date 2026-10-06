/**
 * What a queued job IS, in a sentence a person would use.
 *
 * The handler name is `quote_email`, which is right for a column and wrong for
 * a screen. An IT admin reading a list of failures should not have to know this
 * product's internal vocabulary to work out that a client is waiting on a
 * price.
 *
 * Inert on purpose — no database, no server import — so any component may read
 * it. A client component that imports from `repos/*` pulls `node:crypto` into
 * the browser bundle, which type-checks, builds, and renders a blank page.
 *
 * ── Why the keys are not imported from `outbox-handlers` ──────────────────
 *
 * That module is the handlers themselves: it imports the mail sender, the
 * repositories, the agent. Importing it for two string constants would drag all
 * of that behind it. The strings are stable — they are written into rows that
 * outlive any deploy, so they cannot be renamed casually either way — and the
 * suite checks this map against the real registry, so a handler added without a
 * label here is caught rather than shown to somebody as `booking_email`.
 */
export const JOB_LABELS: Record<string, string> = {
  quote_email: "Quotation email",
  invoice_email: "Invoice email",
  order_email: "Purchase order email",
  message_email: "Message from the inbox",
  booking_email: "Booking confirmation",
  invite_email: "Team invitation",
  call_analysis: "Call write-up",
};

/**
 * The label, or the handler's own name.
 *
 * Falling back to the raw name rather than to "Unknown": a row this map has not
 * been taught about is still something an admin can search for and ask about,
 * and "Unknown" would throw away the one fact the screen actually has.
 */
export function jobLabel(handler: string): string {
  return JOB_LABELS[handler] ?? handler;
}
