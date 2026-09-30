"use server";

import { withSystem, withTenant } from "@/server/tenant";
import { revalidateApp } from "@/server/revalidate";
import { answer } from "@/server/chat-agent";
import { appendChat, clearChat, listChat } from "@/server/repos/chat";
import { id as validId, multiline } from "@/server/validate";
import { requireTenant, withCurrentTenant } from "@/server/tenant-session";
import { requireActivePlan } from "@/server/plan-gate";
import { findUserById } from "@/server/repos/users";
import { deliverQuote } from "@/server/quote-delivery";
import {
  approveQuote,
  discardQuote,
  quotesNeedingUser,
  type Quote,
} from "@/server/repos/quotes";
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

  const message = await deliverQuote(ctx, approval.quote.id);
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

  const message = await deliverQuote(ctx, id);
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
