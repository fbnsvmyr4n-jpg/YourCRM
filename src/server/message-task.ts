import type { MsgCategory } from "@/data/inbox";

/**
 * Turning a message that asks for something into a task.
 *
 * A client writes "can you quote me for the paving" and that is a job to do.
 * It lived only in the Inbox — read, then remembered or not — while the
 * classifier had already worked out what the message was and nothing acted on
 * it. This is the join between the two.
 *
 * The decision is kept pure and separate from the writing because the whole
 * risk of this feature is over-firing. A task list that fills with noise is
 * worse than no task list: people stop reading it, and then the real ones go
 * past too. Every rule below exists to say no more often than yes.
 */

/**
 * The categories that mean somebody is waiting on you.
 *
 * `Tasks` is the classifier's name for "there is an action in here" and
 * `Enquiries` for "someone wants to know what it costs" — both are work.
 *
 * The three left out are deliberate. `Appointments` and `Meeting Requests`
 * are answered by the calendar and the booking page, which already exist and
 * already chase. `Follow-ups` is the classifier's fallback for anything
 * starting "Re:", so acting on it would raise a task for every reply in every
 * thread — the exact flood this feature has to avoid.
 */
export const TASK_CATEGORIES: readonly MsgCategory[] = ["Tasks", "Enquiries"];

export type MessageForTask = {
  direction: "received" | "sent";
  category: MsgCategory | null | undefined;
  subject: string;
  senderName: string | null;
};

/**
 * Whether this message earns a task, and what it should say.
 *
 * Null for "no task", which is the answer most of the time and is meant to be.
 */
export function taskFromMessage(
  message: MessageForTask,
  enabled: boolean
): { title: string; notes: string } | null {
  if (!enabled) return null;
  /* Only what arrived. Something we sent is not somebody waiting on us, and a
     workspace logging its own outbound mail would otherwise raise a task for
     every message it wrote. */
  if (message.direction !== "received") return null;
  /* No confident category means the classifier could not tell what this was,
     and a guess is exactly what must not become a task. */
  if (!message.category || !TASK_CATEGORIES.includes(message.category)) return null;

  const who = message.senderName?.trim() || "a client";
  const subject = message.subject.trim();

  return {
    /* The subject, because that is what the person will recognise on a list
       of twenty tasks. Its own words, never a summary — nothing here is
       clever enough to summarise and a wrong summary is worse than a plain
       one. A message with no subject falls back to naming the sender, so the
       task is never a blank line. */
    title: subject ? `Reply to ${who}: ${subject}` : `Reply to ${who}`,
    /* Where it came from, so nobody has to guess why this appeared — and so
       that deleting it is an easy, confident decision when it is wrong. */
    notes: `Raised from a message in the Inbox, classified as ${message.category}.`,
  };
}

/**
 * One task per conversation, not per message.
 *
 * A thread of six emails about one job is one thing to do. Keyed on the thread
 * and reused by the `todos.source_key` unique index, which is the same
 * mechanism the overdue-invoice chaser uses — so a second message on a thread
 * that already raised a task quietly does nothing.
 */
export const messageTaskKey = (threadId: string) => `message:${threadId}`;
