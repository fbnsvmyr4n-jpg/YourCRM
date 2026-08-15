"use server";

import { revalidateApp } from "@/server/revalidate";
import { createMessage, getMessage, markRead, restoreMessage, trashMessage } from "@/server/inbox-repo";
import { id as validId, multiline, text } from "@/server/validate";

export async function addMessageAction(formData: FormData) {
  // The compose field accepts "Name or email address", so this stays free text
  // — only bounded, not format-checked. The repo already defaults a blank
  // subject to "(no subject)"; the body cap is what matters, because an
  // unbounded one would bloat every read of the whole messages collection.
  const to = text(formData.get("to"), 120);
  if (!to) return;

  const created = await createMessage({
    to,
    subject: text(formData.get("subject"), 200),
    body: multiline(formData.get("body"), 10_000),
  });
  revalidateApp();
  return created.id;
}

/**
 * Reply to, or forward, an existing message.
 *
 * Both buttons were inert. They send through the same `createMessage` path as
 * compose — a reply keeps the thread's subject and recipient, a forward keeps
 * the body and files but needs a new recipient — so a sent reply lands in Sent
 * like any other message rather than being a special case.
 */
export async function replyAction(id: string, formData: FormData) {
  const messageId = validId(id);
  if (!messageId) return;

  const original = await getMessage(messageId);
  if (!original) return;

  const body = multiline(formData.get("body"), 10_000);
  if (!body) return;

  // The recipient is taken from the stored message, never from the form — a
  // reply must go back to the sender, and accepting a posted address would let
  // a forged submission redirect it anywhere.
  const to = original.email && original.email !== "—" ? original.email : original.name;
  const subject = original.subject.replace(/^(re:\s*)+/i, "");

  const created = await createMessage({
    to,
    subject: `Re: ${subject}`,
    body,
    from: {
      name: original.name,
      role: original.role,
      company: original.company,
      phone: original.phone,
      location: original.location,
      timeZone: original.timeZone,
      initials: original.initials,
      color: original.color,
    },
  });

  revalidateApp();
  return created.id;
}

export async function forwardAction(id: string, formData: FormData) {
  const messageId = validId(id);
  if (!messageId) return;

  const original = await getMessage(messageId);
  if (!original) return;

  const to = text(formData.get("to"), 120);
  if (!to) return;

  const note = multiline(formData.get("body"), 10_000);
  const quoted = [
    note,
    note ? "" : null,
    "---------- Forwarded message ----------",
    `From: ${original.name}${original.email && original.email !== "—" ? ` <${original.email}>` : ""}`,
    `Subject: ${original.subject}`,
    "",
    ...original.body,
  ]
    .filter((l) => l !== null)
    .join("\n\n");

  const created = await createMessage({
    to,
    subject: `Fwd: ${original.subject.replace(/^(fwd:\s*)+/i, "")}`,
    body: quoted,
    // The files go with the message — forwarding without them loses the point.
    attachments: original.attachments,
  });

  revalidateApp();
  return created.id;
}

export async function markReadAction(id: string) {
  const messageId = validId(id);
  if (!messageId) return;
  await markRead(messageId);
  revalidateApp();
}

export async function trashMessageAction(id: string) {
  const messageId = validId(id);
  if (!messageId) return;
  await trashMessage(messageId);
  revalidateApp();
}

export async function restoreMessageAction(id: string) {
  const messageId = validId(id);
  if (!messageId) return;
  await restoreMessage(messageId);
  revalidateApp();
}
