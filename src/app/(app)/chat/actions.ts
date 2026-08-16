"use server";

import { revalidateApp } from "@/server/revalidate";
import { answer } from "@/server/chat-agent";
import { appendChat, clearChat, listChat } from "@/server/chat-repo";
import { multiline } from "@/server/validate";
import { requireUser } from "@/server/session";

/** Long enough for a real question, short enough that no single message can
 *  bloat the chat collection or the prompt sent to the model. */
const MAX_QUESTION = 4000;

export async function sendChatAction(text: string) {
  await requireUser();
  const question = multiline(text, MAX_QUESTION);
  if (!question) return null;

  const history = await listChat();
  await appendChat("user", question);

  const { text: reply, live } = await answer(question, history);
  const message = await appendChat("assistant", reply);

  revalidateApp();
  return { message, live };
}

export async function clearChatAction() {
  await requireUser();
  await clearChat();
  revalidateApp();
}
