import { buildRegistry, queueJob, type JobOutcome, type OutboxHandler } from "./outbox";
import type { TenantQuery } from "./tenant";
import { withSystem, withTenant } from "./tenant";
import {
  emailConfigured,
  inviteEmail,
  invoiceEmail,
  messageEmail,
  quotationEmail,
  sendEmail,
} from "./email";
import { findQuote, markQuoteSent } from "./repos/quotes";
import { findInvoice, markInvoiceSent } from "./repos/invoices";
import { canSendOn, findOutgoing, setDelivery } from "./repos/inbox";
import { findUserById } from "./repos/users";
import { createResetToken } from "./repos/auth";
import { getCall } from "./repos/calls";
import { analyseCall, ANALYSIS_MODEL } from "./agent/call-analysis";
import { saveAnalysis } from "./repos/call-analysis";
import { logWrite } from "./log";

/**
 * The jobs the outbox knows how to run.
 *
 * Each one is here because doing it inline was losing work. Both share a shape
 * worth stating once: **the payload carries an id and nothing else, and the
 * handler re-reads the record.** A job queued two minutes ago must act on what
 * is true now — a quotation somebody has since discarded must not be emailed
 * because a copy of its total was captured when the job was made.
 *
 * They also share the reason they can be run twice safely, which they must be,
 * because delivery is at least once: each one checks whether the thing it is
 * about to do has already happened, and the one that talks to an external
 * service passes the job id as that service's idempotency key.
 */

/* ------------------------------------------------------------------ */
/* Sending an approved quotation                                       */
/* ------------------------------------------------------------------ */

export const QUOTE_EMAIL = "quote_email";

/** One job per quotation, so approving twice cannot email the client twice. */
export const quoteEmailKey = (documentId: string) => `${QUOTE_EMAIL}:${documentId}`;

/**
 * Put an approved quotation in the client's inbox.
 *
 * This used to run inline: POST to the provider, then mark the quote sent. Two
 * systems, and a crash in the gap left a customer holding a price the CRM
 * believed was never quoted — with the Send button still on screen, so the
 * fix a person would reach for was to send it again.
 *
 * Now the job is queued in the same transaction that approves the quote, and
 * the mark and the send are the last two things this handler does. It is still
 * possible to send twice — nothing on this side can prevent a crash after the
 * provider has accepted — which is why the job id goes with the request as an
 * idempotency key, and why the handler refuses a quote that is already sent.
 */
const quoteEmailHandler: OutboxHandler = {
  name: QUOTE_EMAIL,
  run: async (payload, job): Promise<JobOutcome> => {
    const documentId = payload.documentId;
    if (!documentId) return { ok: false, retry: false, error: "No documentId in the job" };

    const quote = await withTenant(job.ctx, (q) => findQuote(q, documentId));

    /* Gone, or thrown away since. Nothing to do, and nothing wrong: the job
       is finished, not failed. A retry here would ask about a document that
       is never coming back. */
    if (!quote) return { ok: true, note: "the quotation no longer exists" };
    if (quote.status === "sent" || quote.sentAt) return { ok: true, note: "already sent" };

    /* The last gate before a price reaches a customer, read from the database
       rather than trusted from whoever queued the job. */
    if (!quote.approvedAt || quote.status !== "approved") {
      return { ok: false, retry: false, error: `${quote.number} is not approved` };
    }
    if (!quote.partyEmail) {
      /* Permanent as far as this job is concerned. An address added later is
         a new send, started by a person who can see what happened — better
         than a job retrying quietly for two hours against a blank field. */
      return { ok: false, retry: false, error: `${quote.number} has no address on file` };
    }
    if (!emailConfigured()) {
      /* Transient on purpose: a workspace that switches email on this
         afternoon should find its queued quotations go out, not find them
         dead. The attempt ceiling stops it waiting for ever. */
      return { ok: false, retry: true, error: "email is not configured for this workspace" };
    }

    /*
       The names on the email, resolved AFTER the tenant read and outside it.

       `withSystem` takes a second connection while a tenant transaction holds
       the first — nested, that is a deadlock waiting for a busy pool, and
       immediately a hang under test where the pool is one deep. So the two
       reads are sequential, never nested.

       The approver comes from the DOCUMENT, not from whoever is sending. That
       distinction did not exist when sending happened inline in the approver's
       own request; it does now, because the scheduled sweep sends with no
       person behind it, and a quotation must say who really said yes.
    */
    const who = await withSystem(async (sys) => {
      /* `agency_id` as well as the id, though the id came from a job this
         server queued. A system query carries no row-level security, so the
         agency filter is the only thing standing between a lookup by id and
         another customer's workspace name — and the guard suite treats an
         unfiltered read of this table as a defect wherever it appears. */
      const row = await sys.one<{ name: string }>(
        `SELECT name FROM sub_accounts WHERE id = $2 AND agency_id = $1 AND deleted_at IS NULL`,
        [job.ctx.agencyId, job.ctx.subAccountId]
      );
      const approver = quote.approvedByUserId
        ? await findUserById(sys, quote.approvedByUserId)
        : null;
      return { workspace: row?.name ?? "YourCRM", approver: approver?.name ?? "YourCRM" };
    });

    const { subject, text, html } = quotationEmail({
      number: quote.number,
      project: quote.projectTitle,
      from: who.workspace,
      approvedBy: who.approver,
      notes: quote.notes,
      lines: quote.lines,
      totalCents: quote.totalCents,
    });

    const sent = await sendEmail({
      to: quote.partyEmail,
      subject,
      text,
      html,
      /* Stable across every retry of THIS job and different for every other,
         so a redelivery the provider recognises is dropped at their end
         rather than arriving as a second quotation. */
      idempotencyKey: job.id,
    });
    if (!sent.sent) {
      /* The provider's own verdict on whether this could ever work, rather
         than a guess from here. */
      return { ok: false, retry: !sent.permanent, error: sent.reason ?? "the email did not go" };
    }

    await withTenant(job.ctx, (q) => markQuoteSent(q, quote.id));
    logWrite("send", "quote", { id: quote.id, actor: job.ctx.userId });
    return { ok: true };
  },
};

/* ------------------------------------------------------------------ */
/* Reading a finished call                                             */
/* ------------------------------------------------------------------ */

export const CALL_ANALYSIS = "call_analysis";

/** One job per call. A redelivered status webhook must not analyse it twice. */
export const callAnalysisKey = (callId: string) => `${CALL_ANALYSIS}:${callId}`;

/**
 * Analyse a call that has ended.
 *
 * This ran inline in the telephony webhook, inside a try/catch that swallowed
 * everything — so one timeout from the model lost the analysis permanently,
 * with no record that it had ever been attempted. The specification is
 * explicit that post-call processing must be retryable, and a fire-and-forget
 * call in a serverless function is the opposite of that.
 *
 * Idempotent because the analysis is stored one row per call, replacing what
 * was there. Running it twice costs a second reading and leaves one result.
 */
const callAnalysisHandler: OutboxHandler = {
  name: CALL_ANALYSIS,
  run: async (payload, job): Promise<JobOutcome> => {
    const callId = payload.callId;
    if (!callId) return { ok: false, retry: false, error: "No callId in the job" };

    const call = await withTenant(job.ctx, (q) => getCall(q, callId));
    if (!call) return { ok: true, note: "the call no longer exists" };

    const analysis = await analyseCall(call.transcript);
    /*
       Null is "there was nothing to do", not "it failed": a call of two turns
       has nothing to extract, and a deployment with no API key cannot read
       anything. Neither improves by being retried five more times, and a dead
       row for a greeting-and-goodbye call would be noise in the one list that
       must stay worth reading.
    */
    if (!analysis) return { ok: true, note: "nothing to analyse" };

    await withTenant(job.ctx, (q) => saveAnalysis(q, callId, analysis, ANALYSIS_MODEL));
    return { ok: true };
  },
};

/* ------------------------------------------------------------------ */
/* Sending an invoice                                                  */
/* ------------------------------------------------------------------ */

export const INVOICE_EMAIL = "invoice_email";

/** One job per invoice, so pressing Send twice cannot bill a client twice. */
export const invoiceEmailKey = (documentId: string) => `${INVOICE_EMAIL}:${documentId}`;

/**
 * Put an invoice in the client's inbox.
 *
 * The same shape as the quotation handler and for the same reasons — it
 * re-reads the document, refuses one already sent, and passes the job id as
 * the provider's idempotency key — but the stakes are different enough to say
 * out loud: this is a demand for money. Sending one twice is not an
 * embarrassment, it is a client ringing up about a bill they have already
 * paid.
 *
 * There is no separate approval step, and that is a decision rather than an
 * omission. The approval gate in this product exists because an AI wrote the
 * figures: a quotation drafted by the agent cannot leave without a named human
 * saying yes. An invoice raised from a quotation the client ALREADY accepted
 * carries figures a person approved and a client agreed to — the money has
 * been through the gate twice. Pressing Send is the human decision, and it is
 * recorded as one: `sent_at` and the person who pressed it.
 */
const invoiceEmailHandler: OutboxHandler = {
  name: INVOICE_EMAIL,
  run: async (payload, job): Promise<JobOutcome> => {
    const documentId = payload.documentId;
    if (!documentId) return { ok: false, retry: false, error: "No documentId in the job" };

    const invoice = await withTenant(job.ctx, (q) => findInvoice(q, documentId));
    if (!invoice) return { ok: true, note: "the invoice no longer exists" };
    if (invoice.sentAt) return { ok: true, note: "already sent" };
    if (!invoice.partyEmail) {
      return { ok: false, retry: false, error: `${invoice.number} has no address on file` };
    }
    if (!emailConfigured()) {
      return { ok: false, retry: true, error: "email is not configured for this workspace" };
    }

    const who = await withSystem(async (sys) => {
      const row = await sys.one<{ name: string }>(
        `SELECT name FROM sub_accounts WHERE id = $2 AND agency_id = $1 AND deleted_at IS NULL`,
        [job.ctx.agencyId, job.ctx.subAccountId]
      );
      const sender = await findUserById(sys, job.ctx.userId);
      return { workspace: row?.name ?? "YourCRM", sentBy: sender?.name ?? "YourCRM" };
    });

    const sent = await sendEmail({
      to: invoice.partyEmail,
      ...invoiceEmail({
        number: invoice.number,
        project: invoice.projectTitle,
        from: who.workspace,
        sentBy: who.sentBy,
        dueOn: invoice.dueOn,
        payTo: invoice.payTo,
        notes: invoice.notes,
        lines: invoice.lines,
        totalCents: invoice.totalCents,
      }),
      idempotencyKey: job.id,
    });
    if (!sent.sent) {
      return { ok: false, retry: !sent.permanent, error: sent.reason ?? "the email did not go" };
    }

    await withTenant(job.ctx, (q) => markInvoiceSent(q, invoice.id));
    logWrite("send", "invoice", { id: invoice.id, actor: job.ctx.userId });
    return { ok: true };
  },
};

/* ------------------------------------------------------------------ */
/* Sending a message somebody wrote in the Inbox                       */
/* ------------------------------------------------------------------ */

export const MESSAGE_EMAIL = "message_email";

/** One job per message. A double-pressed Send is one email. */
export const messageEmailKey = (messageId: string) => `${MESSAGE_EMAIL}:${messageId}`;

/**
 * Queue a written message for sending, and say on the message that it is queued.
 *
 * Both halves live here because a caller that does one without the other
 * produces a wrong screen either way round: a job with no `queued` on the
 * message leaves the reader told "recorded here only" about something that is
 * on its way out, and a `queued` with no job is a message that will never
 * move. They are one act, so there is one place to perform it.
 *
 * Returns the job id, which is also what the provider receives as its
 * idempotency key.
 */
export async function queueMessageEmail(q: TenantQuery, messageId: string): Promise<string> {
  await setDelivery(q, messageId, "queued");
  return queueJob(q, OUTBOX_REGISTRY, {
    handler: MESSAGE_EMAIL,
    payload: { messageId },
    dedupeKey: messageEmailKey(messageId),
  });
}

/**
 * Actually send what somebody wrote in the Inbox.
 *
 * The composer used to write a row saying `direction = 'sent'` and transmit
 * nothing — no provider, no queue, no send of any kind anywhere in the
 * feature. Somebody typed a message, pressed send, watched it appear in Sent,
 * and the recipient received nothing. Every Call / Text / Email control across
 * Contacts and Projects leads here, so it was the largest untruth in the
 * product.
 *
 * The message's own `delivery` column now carries the answer, and this handler
 * is what moves it from `queued` to `sent` or `failed`. Nothing marks itself
 * sent on the way in.
 */
const messageEmailHandler: OutboxHandler = {
  name: MESSAGE_EMAIL,
  run: async (payload, job): Promise<JobOutcome> => {
    const messageId = payload.messageId;
    if (!messageId) return { ok: false, retry: false, error: "No messageId in the job" };

    const message = await withTenant(job.ctx, (q) => findOutgoing(q, messageId));
    if (!message) return { ok: true, note: "the message no longer exists" };
    if (message.delivery === "sent") return { ok: true, note: "already sent" };

    const fail = async (reason: string, retry: boolean): Promise<JobOutcome> => {
      /* The ledger is corrected whichever way this goes. A message left saying
         `queued` after we stopped trying would be the same lie in a quieter
         font. */
      if (!retry) await withTenant(job.ctx, (q) => setDelivery(q, messageId, "failed", reason));
      return { ok: false, retry, error: reason };
    };

    if (!canSendOn(message.channel)) {
      /* WhatsApp and SMS have no sending path in this product. Such a message
         should never have been queued, so this is a bug rather than a
         condition to wait out. */
      return fail(`${message.channel} cannot be sent from here`, false);
    }
    if (!message.toEmail) {
      return fail("that contact has no email address on file", false);
    }
    if (!emailConfigured()) {
      /* Transient: a workspace that switches email on this afternoon should
         find its queued messages go out rather than find them dead. */
      return { ok: false, retry: true, error: "email is not configured for this workspace" };
    }

    const who = await withSystem(async (sys) => {
      const row = await sys.one<{ name: string }>(
        `SELECT name FROM sub_accounts WHERE id = $2 AND agency_id = $1 AND deleted_at IS NULL`,
        [job.ctx.agencyId, job.ctx.subAccountId]
      );
      const sender = await findUserById(sys, job.ctx.userId);
      return { workspace: row?.name ?? "YourCRM", fromName: sender?.name ?? "YourCRM" };
    });

    const sent = await sendEmail({
      to: message.toEmail,
      ...messageEmail({
        subject: message.subject,
        body: message.body,
        fromName: who.fromName,
        workspace: who.workspace,
      }),
      idempotencyKey: job.id,
    });
    if (!sent.sent) {
      return fail(sent.reason ?? "the email did not go", !sent.permanent);
    }

    await withTenant(job.ctx, (q) => setDelivery(q, messageId, "sent", null));
    return { ok: true };
  },
};

/* ------------------------------------------------------------------ */
/* Inviting a colleague                                                */
/* ------------------------------------------------------------------ */

export const INVITE_EMAIL = "invite_email";

/** One job per invited person, so inviting twice cannot email them twice. */
export const inviteEmailKey = (userId: string) => `${INVITE_EMAIL}:${userId}`;

/**
 * Send somebody the link that lets them into the account.
 *
 * This ran inline, and its failure was the quietest of the three. The
 * colleague is CREATED either way — they exist on the team, they simply have
 * no way in — and the only trace of the failure was an error message on the
 * inviter's screen that vanished on the next page load. Nobody was watching
 * afterwards, which is the exact shape the queue exists for.
 *
 * ── Why the token is minted here rather than carried in the payload ──────
 *
 * It sets a password on somebody's account. Storing one in a table that exists
 * to be read by a background worker would put a live credential somewhere it
 * has no business being, and an hour later it would be expired anyway.
 *
 * The cost is a real edge worth naming: minting invalidates the previous token
 * for that user, so if a send was accepted by the provider but recorded as
 * failed, a retry kills the link in the email that actually arrived. That
 * degrades to "Forgot your password?", which does the same job and is the
 * fallback the invitation already recommends — a dead link, not a dead end.
 */
const inviteEmailHandler: OutboxHandler = {
  name: INVITE_EMAIL,
  run: async (payload, job): Promise<JobOutcome> => {
    const userId = payload.userId;
    /* The public base URL, captured when the invitation was made. Not customer
       data, and not derivable here: a background drain has no request to read
       a host from, and an env var would produce links on the wrong host for a
       workspace using a custom domain. */
    const origin = payload.origin;
    if (!userId || !origin) return { ok: false, retry: false, error: "Incomplete invitation job" };

    if (!emailConfigured()) {
      /* Transient: a workspace that switches email on this afternoon should
         find its invitations go out rather than find them dead. */
      return { ok: false, retry: true, error: "email is not configured for this workspace" };
    }

    const details = await withSystem(async (sys) => {
      const invited = await findUserById(sys, userId);
      if (!invited) return null;
      const agency = await sys.one<{ name: string }>(`SELECT name FROM agencies WHERE id = $1`, [
        job.ctx.agencyId,
      ]);
      const inviter = await findUserById(sys, job.ctx.userId);
      return {
        email: invited.email,
        agencyName: agency?.name ?? "YourCRM",
        inviterName: inviter?.name ?? "",
        token: await createResetToken(sys, invited.id, invited.email),
      };
    });

    /* Removed from the team since the invitation was queued. Nothing to do,
       and nothing wrong — a retry would keep asking about somebody who is
       deliberately gone. */
    if (!details) return { ok: true, note: "the invited person no longer exists" };

    const link = `${origin}/reset-password?token=${encodeURIComponent(details.token)}`;
    const sent = await sendEmail({
      to: details.email,
      ...inviteEmail(link, details.inviterName, details.agencyName),
      idempotencyKey: job.id,
    });
    if (!sent.sent) {
      return { ok: false, retry: !sent.permanent, error: sent.reason ?? "the email did not go" };
    }
    return { ok: true };
  },
};

/* ------------------------------------------------------------------ */

export const OUTBOX_HANDLERS = [
  quoteEmailHandler,
  callAnalysisHandler,
  inviteEmailHandler,
  invoiceEmailHandler,
  messageEmailHandler,
] as const;
export const OUTBOX_REGISTRY = buildRegistry(OUTBOX_HANDLERS);
