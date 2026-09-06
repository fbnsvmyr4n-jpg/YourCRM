"use server";

import { revalidateApp } from "@/server/revalidate";
import { answer } from "@/server/chat-agent";
import { appendChat, clearChat, listChat } from "@/server/repos/chat";
import { id as validId, multiline } from "@/server/validate";
import { requireTenant, withCurrentTenant } from "@/server/tenant-session";
import { requireActivePlan } from "@/server/plan-gate";
import { withSystem } from "@/server/tenant";
import { findUserById } from "@/server/repos/users";
import { withTenant, type TenantQuery } from "@/server/tenant";
import {
  approveQuote,
  discardQuote,
  findQuote,
  markQuoteSent,
  quotesNeedingUser,
  type Quote,
} from "@/server/repos/quotes";
import { emailConfigured, quotationEmail, sendEmail } from "@/server/email";
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
 * Put an approved quotation in the client's inbox.
 *
 * Shared by approving and by retrying, and it re-reads the quote rather than
 * taking one as an argument: this is the last gate before a price reaches a
 * customer, and it must read the approval from the database rather than trust
 * that its caller just wrote one.
 */
async function deliver(
  q: TenantQuery,
  documentId: string,
  who: { workspace: string; approver: string }
): Promise<string> {
  const quote = await findQuote(q, documentId);
  if (!quote) return "That quotation no longer exists.";
  if (!quote.approvedAt || quote.status !== "approved") {
    return `${quote.number} has not been approved, so nothing was sent.`;
  }

  if (!quote.partyEmail) {
    return `${quote.number} is approved, but ${quote.party ?? "that contact"} has no email address on file. Add one and send it again.`;
  }
  if (!emailConfigured()) {
    return `${quote.number} is approved. Email isn't switched on for this workspace yet, so nothing has been sent.`;
  }

  const { subject, text, html } = quotationEmail({
    number: quote.number,
    project: quote.projectTitle,
    from: who.workspace,
    approvedBy: who.approver,
    notes: quote.notes,
    lines: quote.lines,
    totalCents: quote.totalCents,
  });

  const sent = await sendEmail({ to: quote.partyEmail, subject, text, html });
  if (!sent.sent) {
    /* The approval survives a failed send. Throwing it away would mean asking
       somebody to approve the same figures twice because a mail server was
       briefly down. */
    return `${quote.number} is approved, but the email didn't go: ${sent.reason ?? "unknown error"}. Try again.`;
  }

  await markQuoteSent(q, quote.id);
  logWrite("send", "quote", { id: quote.id, actor: q.ctx.userId });
  return `${quote.number} approved and emailed to ${quote.partyEmail}.`;
}

/**
 * The names that go on the email, resolved BEFORE the tenant transaction opens.
 *
 * `withSystem` takes a second connection out of the pool, and the tenant
 * transaction is holding the first. Nested, that is a deadlock waiting for a
 * busy pool — and immediately a hang under test, where the pool is deliberately
 * one connection deep. Every other caller in this file resolves its system-level
 * reads first for the same reason.
 */
async function signatories(agencyId: string, subAccountId: string, userId: string) {
  return withSystem(async (sys) => {
    /* `agency_id` as well as the id, though the id came from a session the
       server resolved. A system query carries no row-level security, so the
       agency filter is the only thing standing between a lookup by id and
       another customer's workspace name — and the guard suite treats an
       unfiltered read of this table as a defect wherever it appears, which is
       why it is here rather than argued about. */
    const row = await sys.one<{ name: string }>(
      `SELECT name FROM sub_accounts WHERE id = $1 AND agency_id = $2 AND deleted_at IS NULL`,
      [subAccountId, agencyId]
    );
    const user = await findUserById(sys, userId);
    return { workspace: row?.name ?? "YourCRM", approver: user?.name ?? "YourCRM" };
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
  const who = await signatories(ctx.agencyId, ctx.subAccountId, ctx.userId);

  return withCurrentTenant(async (q) => {
    const id = validId(documentId);
    if (!id) return { error: "That quotation could not be identified.", quotes: await quotesNeedingUser(q) };

    const { quote, error } = await approveQuote(q, id);
    if (!quote) return { error, quotes: await quotesNeedingUser(q) };

    logWrite("approve", "quote", { id: quote.id, actor: q.ctx.userId });
    const message = await deliver(q, quote.id, who);

    revalidateApp();
    return { ok: message, quotes: await quotesNeedingUser(q) };
  });
}

/** Try the email again on a quotation somebody already approved. */
export async function sendQuoteAction(documentId: string): Promise<QuoteResult> {
  const ctx = await requireTenant();
  const who = await signatories(ctx.agencyId, ctx.subAccountId, ctx.userId);

  return withCurrentTenant(async (q) => {
    const id = validId(documentId);
    if (!id) return { error: "That quotation could not be identified.", quotes: await quotesNeedingUser(q) };

    const message = await deliver(q, id, who);
    revalidateApp();
    return { ok: message, quotes: await quotesNeedingUser(q) };
  });
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
