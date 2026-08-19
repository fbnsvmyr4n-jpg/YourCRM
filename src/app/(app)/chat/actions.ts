"use server";

import { revalidateApp } from "@/server/revalidate";
import { answer } from "@/server/chat-agent";
import { appendChat, clearChat, listChat } from "@/server/repos/chat";
import { multiline } from "@/server/validate";
import { requireTenant, withCurrentTenant } from "@/server/tenant-session";
import { withSystem } from "@/server/tenant";
import { findUserById } from "@/server/repos/users";
import { withTenant } from "@/server/tenant";

/**
 * Long enough for a real question, short enough that no single message can
 * bloat the stored thread or the prompt sent to the model.
 */
const MAX_QUESTION = 4000;

export async function sendChatAction(text: string) {
  const ctx = await requireTenant();
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
    return { message, live };
  });
}

export async function clearChatAction() {
  return withCurrentTenant(async (q) => {
    // Clears only this person's thread — a colleague's conversation is theirs.
    await clearChat(q);
    revalidateApp();
  });
}
