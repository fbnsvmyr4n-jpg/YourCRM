"use server";

import { revalidateApp } from "@/server/revalidate";
import { answer } from "@/server/chat-agent";
import { appendChat, clearChat, listChat } from "@/server/repos/chat";
import { id as validId, multiline } from "@/server/validate";
import { requireTenant, withCurrentTenant } from "@/server/tenant-session";
import { requireActivePlan } from "@/server/plan-gate";
import { withSystem, withTenant, type TenantContext, type TenantQuery } from "@/server/tenant";
import { findUserById } from "@/server/repos/users";
import { drain, queueJob } from "@/server/outbox";
import { findJob } from "@/server/repos/outbox";
import { OUTBOX_REGISTRY, QUOTE_EMAIL, quoteEmailKey } from "@/server/outbox-handlers";
import {
  approveQuote,
  discardQuote,
  findQuote,
  quotesNeedingUser,
  type Quote,
} from "@/server/repos/quotes";
import { emailConfigured } from "@/server/email";
import { logWrite } from "@/server/log";

/**
 * Long enough for a real question, short enough that no single message can
 * bloat the stored thread or the prompt sent to the model.
 */
const MAX_QUESTION = 4000;

export async function sendChatAction(text: string) {
  const ctx = await requireTenant();

  /**
   * The plan gate, explicitly, because this action resolves the tenant itself
   * rather than going through `withCurrentTenant`.
   *
   * It is the one bypass that costs money per use: every message here is a
   * call to Anthropic's API, billed to us. A cancelled account still running
   * the assistant is not merely using a feature it has not paid for — it is
   * spending our money to do it.
   */
  await requireActivePlan(ctx.agencyId, "chat");

  const question = multiline(text, MAX_QUESTION);
  if (!question) return null;

  // The assistant addresses the person who is actually signed in. This was
  // hardcoded to one name in the system prompt, which was harmless with a
  // single user and a stranger's name on screen the moment there were two.
  const me = await withSystem((q) => findUserById(q, ctx.userId));

  return withTenant(ctx, async (q) => {
    const history = await listChat(q);
    await appendChat(q, "user", question);

    const { text: reply, live } = await answer(q, question, history, me?.name ?? "there");
    const message = await appendChat(q, "assistant", reply);

    revalidateApp();
    /*
       The quotations are re-read rather than returned by the agent.

       Whatever the model did or did not do, this is the true list a moment
       later — including a quote a colleague approved while this message was in
       flight, and excluding one they discarded. Threading the agent's own
       result through would make the screen a report of what the agent believes
       instead of what the database holds.
    */
    return { message, live, quotes: await quotesNeedingUser(q) };
  });
}

/* ------------------------------------------------------------------ */
/* Quotations                                                          */
/*                                                                     */
/* The human half of the drafting loop. The agent writes and revises;  */
/* everything below is a person pressing a button, which is why none   */
/* of it is reachable by the model — there is no tool that calls it.   */
/* ------------------------------------------------------------------ */

export type QuoteResult = { ok?: string; error?: string; quotes: Quote[] };

/**
 * Promise to put an approved quotation in the client's inbox.
 *
 * Queues the send; it does not perform it. That is the whole change, and it
 * closes a real hole: this used to POST to the mail provider and then mark the
 * quote sent, which are two systems with a gap between them. A crash in that
 * gap left a customer holding a price the CRM believed was never quoted — with
 * the Send button still on screen, so the natural next move was to send it
 * again.
 *
 * The job now goes in inside the caller's transaction, so the approval and the
 * promise to deliver it commit together or not at all, and the one job per
 * document means pressing twice cannot email twice.
 *
 * It still re-reads the quote rather than taking one as an argument: this is
 * the last gate before a price reaches a customer, and the handler will read it
 * again for the same reason.
 */
async function promiseDelivery(q: TenantQuery, documentId: string): Promise<string | null> {
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
 * matters here more than anywhere else in the app, because a person has just
 * pressed Approve and is owed a straight answer about whether their client has
 * the price. So the drain runs in the same request and the quote is re-read
 * afterwards: the message says what is true, not what was asked for.
 *
 * When the send has not gone yet the message says so plainly. That is a real
 * improvement on the old "try again", which was the only option when a failed
 * send left nothing behind to retry.
 */
async function deliver(ctx: TenantContext, documentId: string): Promise<string> {
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

/**
 * A person says yes, and it goes.
 *
 * The one place a quotation can leave the building. `approveQuote` stamps who
 * said yes before anything is sent, so a client querying a price six weeks
 * later gets a name rather than "the system".
 */
export async function approveQuoteAction(documentId: string): Promise<QuoteResult> {
  const ctx = await requireTenant();
  const id = validId(documentId);
  if (!id) {
    return {
      error: "That quotation could not be identified.",
      quotes: await withCurrentTenant((q) => quotesNeedingUser(q)),
    };
  }

  /* Approving and queueing the send commit together — that pairing is the
     point. Everything after runs outside, because the delivery talks to a mail
     provider and must not hold this transaction open while it does. */
  const approval = await withCurrentTenant(async (q) => {
    const { quote, error } = await approveQuote(q, id);
    if (!quote) return { error };
    logWrite("approve", "quote", { id: quote.id, actor: q.ctx.userId });
    return { quote };
  });
  if (!approval.quote) {
    return { error: approval.error, quotes: await withCurrentTenant((q) => quotesNeedingUser(q)) };
  }

  const message = await deliver(ctx, approval.quote.id);
  revalidateApp();
  return { ok: message, quotes: await withCurrentTenant((q) => quotesNeedingUser(q)) };
}

/** Try the email again on a quotation somebody already approved. */
export async function sendQuoteAction(documentId: string): Promise<QuoteResult> {
  const ctx = await requireTenant();
  const id = validId(documentId);
  if (!id) {
    return {
      error: "That quotation could not be identified.",
      quotes: await withCurrentTenant((q) => quotesNeedingUser(q)),
    };
  }

  const message = await deliver(ctx, id);
  revalidateApp();
  return { ok: message, quotes: await withCurrentTenant((q) => quotesNeedingUser(q)) };
}

/**
 * Throw a draft away.
 *
 * A soft delete: the agent produced a priced document, and "what did it offer
 * that we decided against" is a real question. It stops appearing; it does not
 * stop having happened.
 */
export async function discardQuoteAction(documentId: string): Promise<QuoteResult> {
  return withCurrentTenant(async (q) => {
    const id = validId(documentId);
    if (!id) return { error: "That quotation could not be identified.", quotes: await quotesNeedingUser(q) };

    const gone = await discardQuote(q, id);
    if (!gone) return { error: "That quotation has already been sent or discarded.", quotes: await quotesNeedingUser(q) };

    logWrite("delete", "quote", { id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: "Draft discarded.", quotes: await quotesNeedingUser(q) };
  });
}

export async function clearChatAction() {
  return withCurrentTenant(async (q) => {
    // Clears only this person's thread — a colleague's conversation is theirs.
    await clearChat(q);
    revalidateApp();
  });
}
