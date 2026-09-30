import { emailConfigured } from "./email";
import { logWrite } from "./log";
import { drain, queueJob } from "./outbox";
import { OUTBOX_REGISTRY, QUOTE_EMAIL, quoteEmailKey } from "./outbox-handlers";
import { findJob } from "./repos/outbox";
import { findQuote } from "./repos/quotes";
import { withTenant, type TenantContext, type TenantQuery } from "./tenant";

/**
 * The one way a quotation leaves the building.
 *
 * This was written for the chat flow, where an agent drafts a price and a
 * named person approves it. A second screen now raises quotations by hand and
 * needs to send them, and the wrong answer would have been to copy this: it is
 * the last gate before a price reaches a customer, and two copies of a last
 * gate is one gate.
 *
 * So it moved here, unchanged in behaviour, and both callers use it.
 */

/**
 * Queue the send, or say why not.
 *
 * Returns a refusal to show the person, or null when the job is queued.
 *
 * The approval is re-read from the database rather than trusted from whoever
 * asked, because this is the last gate; the handler reads it again for the
 * same reason.
 */
export async function promiseDelivery(q: TenantQuery, documentId: string): Promise<string | null> {
  const quote = await findQuote(q, documentId);
  if (!quote) return "That quotation no longer exists.";
  if (!quote.approvedAt || quote.status !== "approved") {
    return `${quote.number} has not been approved, so nothing was sent.`;
  }

  /* Said here as well as in the handler, because these two are worth a person
     knowing NOW rather than finding a dead job later — both need somebody to
     go and change something before any amount of retrying can help. */
  if (!quote.partyEmail) {
    return `${quote.number} is approved, but ${quote.party ?? "that contact"} has no email address on file. Add one and send it again.`;
  }
  if (!emailConfigured()) {
    return `${quote.number} is approved. Email isn't switched on for this workspace yet, so nothing has been sent.`;
  }

  await queueJob(q, OUTBOX_REGISTRY, {
    handler: QUOTE_EMAIL,
    payload: { documentId: quote.id },
    dedupeKey: quoteEmailKey(quote.id),
  });
  return null;
}

/**
 * Queue the send, then try it at once and report what actually happened.
 *
 * The queue is the guarantee, this is the immediacy — and the immediacy
 * matters here more than anywhere else, because a person has just pressed
 * Approve and is owed a straight answer about whether their client has the
 * price. So the drain runs in the same request and the quote is re-read
 * afterwards: the message says what is true, not what was asked for.
 */
export async function deliverQuote(ctx: TenantContext, documentId: string): Promise<string> {
  const refusal = await withTenant(ctx, (q) => promiseDelivery(q, documentId));
  if (refusal) return refusal;

  await drain(ctx, OUTBOX_REGISTRY, 5).catch(() => {
    /* Swallowed: the job is durable, and the re-read below tells the truth
       about where it got to. */
  });

  return withTenant(ctx, async (q) => {
    const quote = await findQuote(q, documentId);
    if (!quote) return "That quotation no longer exists.";
    if (quote.status === "sent" || quote.sentAt) {
      logWrite("send", "quote", { id: quote.id, actor: ctx.userId });
      return `${quote.number} approved and emailed to ${quote.partyEmail}.`;
    }

    /* Three different truths hide behind "queued", and saying "we'll keep
       trying" about a job that has already stopped is worse than saying
       nothing. So the job itself is read, not assumed. */
    const job = await findJob(q, QUOTE_EMAIL, quoteEmailKey(documentId));
    if (job?.status === "dead") {
      return `${quote.number} is approved, but it couldn't be sent: ${job.lastError ?? "unknown error"}. Fix that and send it again.`;
    }
    return `${quote.number} is approved and queued to send. It hasn't gone out yet — we'll keep trying, and you can send it again yourself.`;
  });
}
