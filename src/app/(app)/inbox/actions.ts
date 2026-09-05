"use server";

import { revalidateApp } from "@/server/revalidate";
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
import { linkContactByName } from "@/server/link-contact";
import { withCurrentTenant } from "@/server/tenant-session";
import { MSG_CATEGORIES } from "@/data/inbox";
import { id as validId, multiline, pick, text } from "@/server/validate";

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

export async function addMessageAction(formData: FormData) {
  return withCurrentTenant(async (q) => {
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

    const created = await createMessage(q, {
      direction: "sent",
      contactId,
      /* Which transport this was. Without somewhere to say it, WhatsApp could
         never legitimately appear on a badge, and offering a channel nothing
         can produce is the same class of lie as a phantom lead. Defaults to
         email, which is what this composer actually sends. */
      channel: pick(formData.get("channel"), CHANNELS) ?? "email",
      subject: text(formData.get("subject"), 200),
      body: multiline(formData.get("body"), 10_000),
    });

    revalidateApp();
    return created.id;
  });
}

/**
 * Reply to an existing message.
 *
 * The recipient comes from the stored message, never from the form. A reply
 * must go back to the sender, and accepting a posted address would let a
 * forged submission redirect it anywhere.
 */
export async function replyAction(id: string, formData: FormData) {
  return withCurrentTenant(async (q) => {
    const messageId = validId(id);
    if (!messageId) return null;

    const original = await getMessage(q, messageId);
    if (!original) return null;

    const body = multiline(formData.get("body"), 10_000);
    if (!body) return null;

    const subject = original.subject.replace(/^(re:\s*)+/i, "");
    const created = await createMessage(q, {
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
    });

    revalidateApp();
    return created.id;
  });
}

export async function forwardAction(id: string, formData: FormData) {
  return withCurrentTenant(async (q) => {
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

    const created = await createMessage(q, {
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
    });

    revalidateApp();
    return created.id;
  });
}

export async function markReadAction(id: string) {
  return withCurrentTenant(async (q) => {
    const messageId = validId(id);
    if (!messageId) return;
    await setUnread(q, messageId, false);
    revalidateApp();
  });
}

/** Deliberately available: marking something unread again is how people queue work. */
export async function markUnreadAction(id: string) {
  return withCurrentTenant(async (q) => {
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
  return withCurrentTenant(async (q) => {
    const messageId = validId(id);
    if (!messageId) return;
    const value = category ? pick(category, MSG_CATEGORIES) : null;
    if (category && !value) return;
    await setCategory(q, messageId, value);
    revalidateApp();
  });
}

export async function trashMessageAction(id: string) {
  return withCurrentTenant(async (q) => {
    const messageId = validId(id);
    if (!messageId) return;
    await trashMessage(q, messageId);
    revalidateApp();
  });
}

export async function restoreMessageAction(id: string) {
  return withCurrentTenant(async (q) => {
    const messageId = validId(id);
    if (!messageId) return;
    await restoreMessage(q, messageId);
    revalidateApp();
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
  return withCurrentTenant(async (q) => {
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
