"use server";

import { emailConfigured } from "@/server/email";
import { logWrite } from "@/server/log";
import { drain, queueJob } from "@/server/outbox";
import { ORDER_EMAIL, orderEmailKey, OUTBOX_REGISTRY } from "@/server/outbox-handlers";
import { findJob } from "@/server/repos/outbox";
import { findOrder } from "@/server/repos/quotes";
import { revalidateApp } from "@/server/revalidate";
import { withTenant } from "@/server/tenant";
import { requireTenant, withCurrentTenant } from "@/server/tenant-session";
import { id as validId } from "@/server/validate";
import type { FormState } from "@/app/(app)/projects/actions";

/**
 * Sending a purchase order to a supplier.
 *
 * The same shape as sending a quotation and deliberately its own code, because
 * what has to be true first differs. A quotation may not leave without a named
 * approver — a price reaching a client is a commitment somebody must own. An
 * order does not need one: it is counted in a project's committed money from
 * the moment it is drafted, so the decision was made before this point rather
 * than at it.
 *
 * What it does refuse is sending one twice. An order that arrives twice is two
 * deliveries and an argument about an invoice, so the queue is deduplicated on
 * the document and the handler re-reads `sent_at` before it transmits.
 */
export async function sendOrderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireTenant();
  const documentId = validId(formData.get("documentId"));
  if (!documentId) return { error: "That purchase order could not be identified." };

  const refusal = await withCurrentTenant(async (q) => {
    const order = await findOrder(q, documentId);
    if (!order) return "That purchase order no longer exists.";
    if (order.sentAt) return `${order.number} has already been sent.`;
    if (order.status === "cancelled" || order.status === "declined") {
      return `${order.number} has been called off, so it was not sent.`;
    }
    /* Said here as well as in the handler, because both need somebody to go
       and change something before any amount of retrying can help. */
    if (!order.partyEmail) {
      return `${order.number} has no supplier email address. Add one to the order and send it again.`;
    }
    if (!emailConfigured()) {
      return `Email isn't switched on for this workspace yet, so ${order.number} has not been sent.`;
    }

    await queueJob(q, OUTBOX_REGISTRY, {
      handler: ORDER_EMAIL,
      payload: { documentId: order.id },
      dedupeKey: orderEmailKey(order.id),
    });
    return null;
  });

  if (refusal && typeof refusal === "object") return refusal as { error: string };
  if (refusal) return { error: refusal };

  /* The queue is the guarantee; this is the immediacy. Somebody has just
     committed money and is owed a straight answer about whether the supplier
     has the order. */
  await drain(ctx, OUTBOX_REGISTRY, 5).catch(() => {});

  const after = await withTenant(ctx, async (q) => ({
    order: await findOrder(q, documentId),
    job: await findJob(q, ORDER_EMAIL, orderEmailKey(documentId)),
  }));

  revalidateApp();

  if (after.order?.sentAt) {
    logWrite("send", "purchase_order", { id: documentId, actor: ctx.userId });
    return { ok: `${after.order.number} sent to ${after.order.partyEmail}.` };
  }
  if (after.job?.status === "dead") {
    return {
      error: `${after.order?.number ?? "That order"} couldn't be sent: ${after.job.lastError ?? "unknown error"}. Fix that and send it again.`,
    };
  }
  return {
    ok: `${after.order?.number ?? "The order"} is queued to send. It hasn't gone out yet — we'll keep trying, and you can send it again yourself.`,
  };
}
