import { buildRegistry, type JobOutcome, type OutboxHandler } from "./outbox";
import { withSystem, withTenant } from "./tenant";
import { emailConfigured, quotationEmail, sendEmail } from "./email";
import { findQuote, markQuoteSent } from "./repos/quotes";
import { findUserById } from "./repos/users";
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

export const OUTBOX_HANDLERS = [quoteEmailHandler, callAnalysisHandler] as const;
export const OUTBOX_REGISTRY = buildRegistry(OUTBOX_HANDLERS);
