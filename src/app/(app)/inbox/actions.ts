"use server";

import { revalidatePath } from "next/cache";
import { createMessage, markRead, restoreMessage, trashMessage } from "@/server/inbox-repo";
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
  revalidatePath("/inbox");
  return created.id;
}

export async function markReadAction(id: string) {
  const messageId = validId(id);
  if (!messageId) return;
  await markRead(messageId);
  revalidatePath("/inbox");
}

export async function trashMessageAction(id: string) {
  const messageId = validId(id);
  if (!messageId) return;
  await trashMessage(messageId);
  revalidatePath("/inbox");
}

export async function restoreMessageAction(id: string) {
  const messageId = validId(id);
  if (!messageId) return;
  await restoreMessage(messageId);
  revalidatePath("/inbox");
}
