"use server";

import { revalidateApp } from "@/server/revalidate";
import { type WriteResult } from "@/server/write-result";
import {
  CHANNELS,
  createMessage,
  fileThread,
  getMessage,
  restoreMessage,
  setCategory,
  setUnread,
  trashMessage,
} from "@/server/repos/inbox";
import { getContact } from "@/server/repos/contacts";
import { discardDraft, saveDraft, type Draft } from "@/server/repos/drafts";
import { linkContactByName } from "@/server/link-contact";
import { autoLoadFromMessage } from "@/server/supplier-auto-load";
import { requireTenant, withCurrentTenant } from "@/server/tenant-session";
import type { TenantContext, TenantQuery } from "@/server/tenant";
import { canSendOn, findOutgoing, setDelivery, type Channel } from "@/server/repos/inbox";
import { drain } from "@/server/outbox";
import { OUTBOX_REGISTRY, queueMessageEmail } from "@/server/outbox-handlers";
import { MSG_CATEGORIES } from "@/data/inbox";
import { id as validId, multiline, pick, text } from "@/server/validate";
import { openTicket, updateTicket } from "@/server/repos/tickets";
import { assignableTeam } from "@/server/repos/automations";
import { logWrite } from "@/server/log";
import { TICKET_PRIORITIES, TICKET_STATUSES, type Ticket } from "@/server/ticket-rules";

/*
   EVERY action in this file opens the MAIL door rather than the customer-data
   one — `withCurrentTenant(fn, { mail: true })`.

   A bookkeeper replies to a client about an invoice, forwards a supplier's
   statement, logs a payment remittance that arrived. Asking the
   customer-records question of them refused all of it, which made the finance
   role an account that can read figures somebody else keyed in and do nothing.
   IT is refused by the same option, which is the point of it being its own
   door rather than an opt-out.
*/

/**
 * Inbox actions.
 *
 * A message links to a contact by id now, so composing to someone finds or
 * creates that person rather than storing their name as a loose string. The
 * old row carried a frozen copy of the sender's company and phone number,
 * which is why a contact who changed jobs still showed their old company in
 * the inbox forever.
 *
 * There is no attachment storage yet, so forwarding carries the text and says
 * nothing about files. Claiming to forward attachments that do not exist is
 * the same class of lie as the phantom lead.
 */


/**
 * Hand a written message to the outbox, and say what really happened to it.
 *
 * This is the piece that was missing. The composer created a row marked
 * `sent` and nothing was ever transmitted — no provider, no queue, no send
 * anywhere in the feature. What it produced was a record of correspondence
 * presented as correspondence.
 *
 * Now: email is queued and actually goes; a channel this product cannot
 * transmit on stays `logged`, which is the honest word for "we wrote this
 * down"; and a message with no address to send to says so rather than sitting
 * in a queue nothing can satisfy.
 *
 * Returns what the screen should tell the person, or null when it simply went.
 */
async function deliver(
  ctx: TenantContext,
  message: { id: string; channel: Channel; contactId: string | null }
): Promise<string | null> {
  if (!canSendOn(message.channel)) {
    /* WhatsApp and SMS have no sending path here, and pretending otherwise is
       the exact defect this change exists to remove. Recorded, and named as a
       record. */
    return `Logged. ${message.channel === "sms" ? "SMS" : "WhatsApp"} messages are recorded here, not sent — send it from your phone.`;
  }

  const recipient = await withMail((q) => findOutgoing(q, message.id));
  if (!recipient?.toEmail) {
    await withMail((q) => setDelivery(q, message.id, "failed", "no email address on file"));
    return "Saved, but not sent: there is no email address for that contact. Add one and send again.";
  }

  await withMail((q) => queueMessageEmail(q, message.id));

  /* Drained here so the common case is done before the writer looks away; the
     queue is what guarantees it happens at all. */
  await drain(ctx, OUTBOX_REGISTRY, 5).catch(() => {});

  const after = await withMail((q) => findOutgoing(q, message.id));
  if (after?.delivery === "sent") return null;
  if (after?.delivery === "failed") {
    return `Saved, but it could not be sent: ${after.deliveryError ?? "unknown error"}`;
  }
  return "Saved and queued to send. It hasn't gone out yet — we'll keep trying, and it will show in your notifications if it cannot be sent.";
}

/**
 * Write a message and actually send it.
 *
 * Returns the new message's id and, when there is something the writer needs
 * to know, a notice. Silence means it went — a screen that says "sent" every
 * time is the same screen that said it before anything was being sent.
 */
/**
 * Every action in this file, through the MAIL door.
 *
 * Named once rather than `{ mail: true }` repeated eighteen times — and
 * repeated eighteen times is how one of them ends up without it, which would
 * be an action a bookkeeper silently cannot use. `authorisation.test.ts`
 * accepts this because it IS `withCurrentTenant`: same guard, same first
 * statement, one option fixed.
 */
const withMail = <T>(fn: (q: TenantQuery) => Promise<T>) => withCurrentTenant(fn, { mail: true });

export async function addMessageAction(
  formData: FormData
): Promise<{ id: string; notice: string | null } | null> {
  const ctx = await requireTenant();

  const created = await withMail(async (q) => {
    // The compose field accepts "Name or email address", so it stays free text
    // — bounded, not format-checked.
    const to = text(formData.get("to"), 120);
    if (!to) return null;

    const looksLikeEmail = to.includes("@");
    const contactId = await linkContactByName(
      q,
      looksLikeEmail ? to.split("@")[0].replace(/[._]/g, " ") : to,
      looksLikeEmail ? to : null
    );

    return createMessage(q, {
      direction: "sent",
      contactId,
      /* Which transport this was. Without somewhere to say it, WhatsApp could
         never legitimately appear on a badge, and offering a channel nothing
         can produce is the same class of lie as a phantom lead. */
      channel: pick(formData.get("channel"), CHANNELS) ?? "email",
      subject: text(formData.get("subject"), 200),
      body: multiline(formData.get("body"), 10_000),
      /* Nothing marks itself sent on the way in. `deliver` decides, and only
         the provider accepting it makes it `sent`. */
      delivery: "logged",
    });
  });
  if (!created) return null;
  /* Refused for a view-only person: nothing was written, so nothing to send. */
  if ("error" in created) return { id: "", notice: String(created.error) };

  const notice = await deliver(ctx, created);
  revalidateApp();
  return { id: created.id, notice };
}

/**
 * Reply to an existing message.
 *
 * The recipient comes from the stored message, never from the form. A reply
 * must go back to the sender, and accepting a posted address would let a
 * forged submission redirect it anywhere.
 */
export async function replyAction(
  id: string,
  formData: FormData
): Promise<{ id: string; notice: string | null } | null> {
  const ctx = await requireTenant();

  const created = await withMail(async (q) => {
    const messageId = validId(id);
    if (!messageId) return null;

    const original = await getMessage(q, messageId);
    if (!original) return null;

    const body = multiline(formData.get("body"), 10_000);
    if (!body) return null;

    const subject = original.subject.replace(/^(re:\s*)+/i, "");
    return createMessage(q, {
      direction: "sent",
      // Same thread, same person — carried by the link rather than re-derived
      // from a name that might now match somebody else.
      contactId: original.contactId,
      /* And the same conversation. Without this every reply opened a NEW
         thread, which is the threading being broken for exactly the case it
         exists for — silently, because a thread of one looks like a thread.
         The project comes with it: a reply about the Stellenbosch job is about
         the Stellenbosch job. */
      threadId: original.threadId,
      dealId: original.dealId,
      /* A reply to a WhatsApp is a WhatsApp. Defaulting it to email would put
         two transports in one conversation and make the thread's badges
         disagree with each other. */
      channel: original.channel,
      subject: `Re: ${subject}`,
      body,
      /* Same rule as a new message: nothing claims to have been sent until
         something sent it. */
      delivery: "logged",
    });
  });
  if (!created) return null;
  /* Refused for a view-only person: nothing was written, so nothing to send. */
  if ("error" in created) return { id: "", notice: String(created.error) };

  const notice = await deliver(ctx, created);
  revalidateApp();
  return { id: created.id, notice };
}

export async function forwardAction(
  id: string,
  formData: FormData
): Promise<{ id: string; notice: string | null } | null> {
  const ctx = await requireTenant();

  const created = await withMail(async (q) => {
    const messageId = validId(id);
    if (!messageId) return null;

    const original = await getMessage(q, messageId);
    if (!original) return null;

    const to = text(formData.get("to"), 120);
    if (!to) return null;

    const from = original.contactId ? await getContact(q, original.contactId) : null;
    const fromName = from ? `${from.firstName} ${from.lastName}`.trim() : "Unknown sender";

    const note = multiline(formData.get("body"), 10_000);
    const quoted = [
      note,
      note ? "" : null,
      "---------- Forwarded message ----------",
      `From: ${fromName}${from?.email ? ` <${from.email}>` : ""}`,
      `Subject: ${original.subject}`,
      "",
      original.body,
    ]
      .filter((l) => l !== null)
      .join("\n\n");

    const looksLikeEmail = to.includes("@");
    const contactId = await linkContactByName(
      q,
      looksLikeEmail ? to.split("@")[0].replace(/[._]/g, " ") : to,
      looksLikeEmail ? to : null
    );

    return createMessage(q, {
      direction: "sent",
      contactId,
      /* A forward opens its OWN thread — deliberately, and this is the one
         place the two differ. It goes to somebody else, and pulling a third
         party into the client's conversation would put their reply in front of
         the client. It keeps the project, because a forward about this job is
         still about this job. */
      dealId: original.dealId,
      channel: original.channel,
      subject: `Fwd: ${original.subject.replace(/^(fwd:\s*)+/i, "")}`,
      body: quoted,
      delivery: "logged",
    });
  });
  if (!created) return null;
  /* Refused for a view-only person: nothing was written, so nothing to send. */
  if ("error" in created) return { id: "", notice: String(created.error) };

  const notice = await deliver(ctx, created);
  revalidateApp();
  return { id: created.id, notice };
}

export async function markReadAction(id: string) {
  return withMail(async (q) => {
    const messageId = validId(id);
    if (!messageId) return;
    await setUnread(q, messageId, false);
    revalidateApp();
  });
}

/** Deliberately available: marking something unread again is how people queue work. */
export async function markUnreadAction(id: string) {
  return withMail(async (q) => {
    const messageId = validId(id);
    if (!messageId) return;
    await setUnread(q, messageId, true);
    revalidateApp();
  });
}

/**
 * Override the classifier's guess, or hand the message back to it.
 *
 * Passing nothing clears the override rather than blanking the category — a
 * message always has whatever the rules say it is.
 */
export async function setCategoryAction(id: string, category: string | null) {
  return withMail(async (q) => {
    const messageId = validId(id);
    if (!messageId) return;
    const value = category ? pick(category, MSG_CATEGORIES) : null;
    if (category && !value) return;
    await setCategory(q, messageId, value);
    revalidateApp();
  });
}

export async function trashMessageAction(id: string): Promise<WriteResult> {
  return withMail(async (q) => {
    const messageId = validId(id);
    if (!messageId) return { error: "That message could not be identified." };
    await trashMessage(q, messageId);
    revalidateApp();
    return { ok: true };
  });
}

export async function restoreMessageAction(id: string): Promise<WriteResult> {
  return withMail(async (q) => {
    const messageId = validId(id);
    if (!messageId) return { error: "That message could not be identified." };
    await restoreMessage(q, messageId);
    revalidateApp();
    return { ok: true };
  });
}

/**
 * File a conversation against a project, or take it off one.
 *
 * Takes the THREAD id, not the message id, because that is the unit: a job's
 * mail is conversations, and half a conversation filed one way and half the
 * other is a state that makes both screens wrong.
 *
 * An empty `dealId` means "not filed", which is a real answer somebody chooses
 * — a thread wrongly attached needs a way back off, and requiring them to pick
 * a different wrong project instead is not one.
 */
export async function fileThreadAction(threadId: string, dealId: string | null) {
  return withMail(async (q) => {
    const thread = validId(threadId);
    if (!thread) return { error: "That conversation could not be identified." };

    const target = dealId === null || dealId === "" ? null : validId(dealId);
    if (dealId && !target) return { error: "That project could not be identified." };

    const result = await fileThread(q, thread, target);
    if ("error" in result) return result;

    revalidateApp();
    const n = result.moved;
    const plural = `${n} ${n === 1 ? "message" : "messages"}`;
    return { ok: target ? `${plural} filed against the project.` : `${plural} unfiled.` };
  });
}


/* ------------------------------------------------------------------ */
/* Tickets                                                             */
/*                                                                     */
/* Anybody who works the customer records can track a conversation,    */
/* take it, hand it on and close it — that is the work, the same as     */
/* replying is.                                                        */
/* ------------------------------------------------------------------ */

type TicketResult = { error: string } | { ok: true; ticket: Ticket };

/** Only people who can see customer records can be handed a customer's conversation. */
async function checkAssignee(q: TenantQuery, raw: unknown): Promise<{ id: string | null } | { error: string }> {
  if (raw === null || raw === "") return { id: null };
  const id = validId(raw);
  if (!id || !(await assignableTeam(q)).some((p) => p.id === id)) {
    return { error: "That person cannot be given tickets in this workspace." };
  }
  return { id };
}

/** Start tracking a conversation as a ticket. */
export async function trackTicketAction(threadId: string): Promise<TicketResult> {
  return withMail(async (q) => {
    const thread = validId(threadId);
    if (!thread) return { error: "That conversation no longer exists." };
    const out = await openTicket(q, thread);
    if ("error" in out) return out;
    if (out.created) logWrite("create", "ticket", { id: out.ticket.id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: true as const, ticket: out.ticket };
  });
}

export async function updateTicketAction(
  ticketId: string,
  patch: { status?: string; priority?: string; assigneeUserId?: string | null }
): Promise<TicketResult> {
  return withMail(async (q) => {
    const id = validId(ticketId);
    if (!id) return { error: "That ticket no longer exists." };

    const status = patch.status === undefined ? undefined : pick(patch.status, TICKET_STATUSES);
    if (status === null) return { error: "That is not a ticket status." };
    const priority = patch.priority === undefined ? undefined : pick(patch.priority, TICKET_PRIORITIES);
    if (priority === null) return { error: "That is not a priority." };

    let assigneeUserId: string | null | undefined;
    if (patch.assigneeUserId !== undefined) {
      const who = await checkAssignee(q, patch.assigneeUserId);
      if ("error" in who) return who;
      assigneeUserId = who.id;
    }

    const out = await updateTicket(q, id, { status, priority, assigneeUserId });
    if ("error" in out) return out;
    logWrite("update", "ticket", { id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: true as const, ticket: out.ticket };
  });
}

/** How far ahead of the server clock a logged message may claim to be. */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * What logging a received message answers, inside the gate.
 *
 * Named rather than inferred, and declared out here rather than inside the
 * function. Inferred, the two branches widen into a shape carrying
 * `error?: undefined` on the success side and the narrowing afterwards stops
 * working — which matters, because the refusal the gate can return has to
 * survive into the second half of that function intact.
 *
 * `forPrices` is the message restated as the price-list recogniser wants it,
 * carried out of the mail door so the list can be loaded behind the money one.
 */
type LoggedMessage =
  | { error: string }
  | {
      ok: true;
      id: string;
      ticket: Ticket | null;
      forPrices: {
        id: string;
        direction: "received";
        email: string;
        subject: string;
        body: string[];
      };
    };

/**
 * Record a message somebody RECEIVED — a WhatsApp on their phone, a call, an
 * email in another mailbox.
 *
 * Nothing brings inbound mail into this product yet, so without this the
 * Received folder could only ever hold imported history, and a support
 * conversation could never start here. It is marked read: the person logging
 * it has read it. Optionally it opens a ticket in the same go.
 */
export async function logReceivedAction(
  formData: FormData
): Promise<
  { error: string } | { ok: true; id: string; ticket: Ticket | null; priceList: string | null }
> {
  const logged = await withMail<LoggedMessage>(async (q) => {
    const from = text(formData.get("to"), 120);
    if (!from) return { error: "Say who it was from." };
    const body = multiline(formData.get("body"), 10_000);
    if (!body) return { error: "Type or paste what they said." };

    let sentAt: Date | undefined;
    const when = text(formData.get("receivedAt"), 40);
    if (when) {
      const d = new Date(when);
      if (Number.isNaN(d.getTime())) return { error: "That time is not valid." };
      if (d.getTime() > Date.now() + CLOCK_SKEW_MS) return { error: "A message cannot arrive in the future." };
      sentAt = d;
    }

    const looksLikeEmail = from.includes("@");
    const contactId = await linkContactByName(
      q,
      looksLikeEmail ? from.split("@")[0].replace(/[._]/g, " ") : from,
      looksLikeEmail ? from : null
    );

    const created = await createMessage(q, {
      direction: "received",
      contactId,
      channel: pick(formData.get("channel"), CHANNELS) ?? "email",
      subject: text(formData.get("subject"), 200),
      body,
      sentAt,
      unread: false,
    });

    let ticket: Ticket | null = null;
    if (formData.get("openTicket") === "on") {
      const out = await openTicket(q, created.threadId);
      if ("ticket" in out) {
        ticket = out.ticket;
        logWrite("create", "ticket", { id: ticket.id, actor: q.ctx.userId });
      }
    }

    revalidateApp();
    return {
      ok: true as const,
      id: created.id,
      ticket,
      /* Carried out of the mail door so the price list can be loaded behind
         the money one — see below. */
      forPrices: {
        id: created.id,
        direction: "received" as const,
        email: looksLikeEmail ? from : "",
        subject: text(formData.get("subject"), 200),
        body: body.split("\n"),
      },
    };
  });

  if ("error" in logged) return { error: logged.error };

  /*
     A supplier's price list, loaded without being asked — slice 2b.

     OUTSIDE the transaction above, and through the MONEY door rather than the
     mail one, for two separate reasons:

       - Recognising a price list in an email is mail work. Writing what this
         business pays for stone is not, and running it on the inbox's querier
         would be the money gate widened by proximity to the thing that happened
         to trigger it.

       - A write refused in there would roll back the message as well. A
         view-only reader logging what a supplier said must still get their
         message saved, and the price write is the part that is supposed to
         fail for them.

     Swallowed on failure for the same reason: the message is the thing the
     person asked for, and a supplier list that did not load is a card in the
     inbox, which is the normal state of every message that arrives.
  */
  const priceList = await withCurrentTenant(
    (q) => autoLoadFromMessage(q, logged.forPrices),
    { money: true }
  ).catch(() => null);

  return {
    ok: true as const,
    id: logged.id,
    ticket: logged.ticket,
    priceList:
      priceList && "loaded" in priceList && priceList.loaded
        ? `${priceList.supplierName}'s price list was loaded — ${[
            priceList.result.added && `${priceList.result.added} added`,
            priceList.result.repriced && `${priceList.result.repriced} repriced`,
            priceList.result.unchanged && `${priceList.result.unchanged} unchanged`,
          ]
            .filter(Boolean)
            .join(", ")}.`
        : null,
  };
}

/* ------------------------------------------------------------------ */
/* Drafts                                                              */
/*                                                                     */
/* An email somebody started and has not sent. The browser keeps the   */
/* box being typed in; these keep what survives it closing.            */
/* ------------------------------------------------------------------ */

/**
 * Keep what is in the composer.
 *
 * Returns the saved draft rather than nothing, because the composer needs the
 * id back: without it, closing a new message twice would leave two rows for one
 * piece of writing. This is the shape the nine toggle-and-delete call sites got
 * wrong — an action whose result is discarded is an action whose failure is
 * invisible — so the caller is given something to hold on to and to check.
 */
export async function saveDraftAction(draft: {
  id?: string | null;
  to: string;
  subject: string;
  body: string;
}): Promise<Draft | null> {
  return withMail(async (q) => {
    const saved = await saveDraft(q, {
      id: draft.id ? validId(draft.id) : null,
      to: text(draft.to, 320),
      subject: text(draft.subject, 200),
      body: multiline(draft.body, 20000),
    });
    if (saved) revalidateApp();
    return saved;
  });
}

/** Throw a draft away. Says whether it went, so the list is not told a lie. */
export async function discardDraftAction(id: string): Promise<boolean> {
  return withMail(async (q) => {
    const draftId = validId(id);
    if (!draftId) return false;
    const gone = await discardDraft(q, draftId);
    if (gone) revalidateApp();
    return gone;
  });
}
