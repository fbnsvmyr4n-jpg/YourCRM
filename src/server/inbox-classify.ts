import { MSG_CATEGORIES, type MsgCategory } from "@/data/inbox";
import { rankIntents, type Intent } from "./chat-intents";

/**
 * What kind of message this is.
 *
 * The five category chips above the inbox were decoration — they had nothing to
 * filter on, because a message carried no category. New messages store one; old
 * ones are classified here on read, so the chips work across everything rather
 * than only what has arrived since.
 *
 * Reuses the assistant's scoring matcher, so a near-miss or a typo still lands
 * in the right bucket. Pure, so the rules can be tested directly.
 */

const RULES: Intent[] = [
  {
    id: "Meeting Requests",
    keywords: ["meet", "meeting", "call", "demo", "walkthrough", "availability", "slot", "diary", "schedule"],
    phrases: [
      "could we",
      "are you free",
      "set up 30",
      "grab 30",
      "book a time",
      "meeting request",
      "next week to",
      "would next",
      "suit for",
      "intro call",
    ],
    weight: 1.15,
  },
  {
    id: "Appointments",
    keywords: ["confirmed", "confirm", "booked", "scheduled", "appointment", "reminder", "calendar", "invite"],
    phrases: ["see you on", "is confirmed", "has been booked", "calendar invite"],
    weight: 1.1,
  },
  {
    id: "Tasks",
    keywords: ["invoice", "payment", "paid", "deadline", "sign", "signature", "approve", "action", "due", "send", "review", "contract"],
    phrases: ["please confirm", "needs your", "action required", "before friday", "can you send"],
  },
  {
    id: "Follow-ups",
    keywords: ["following", "followup", "circle", "circling", "update", "checking", "proposal", "feedback", "thoughts", "revert"],
    phrases: [
      "thanks for the call",
      "circle back",
      "following up",
      "any update",
      "as discussed",
      "let me know",
      // Past-tense gratitude is the tell that something already happened, so
      // the message is a follow-up *about* it rather than a request for it.
      // Without these, "thanks for making time for the demo" scored as a
      // meeting request purely because it contains the word "demo".
      "thanks for making time",
      "thanks for the demo",
      "thanks for the meeting",
      "great to connect",
    ],
  },
  {
    id: "Enquiries",
    keywords: ["interested", "enquiry", "enquiries", "inquiry", "pricing", "price", "cost", "information", "learn", "curious", "wondering"],
    phrases: ["love to learn", "more about", "how do you", "could you tell", "looking for"],
  },
];

/** Below this nothing has a real claim and the message is left uncategorised. */
const THRESHOLD = 0.3;

export function classifyMessage(subject: string, body: string[]): MsgCategory | undefined {
  const text = `${subject} ${body.join(" ")}`;

  const top = rankIntents(text, RULES, { unique: true })[0];

  if (!top || top.score < THRESHOLD) {
    // Nothing has a confident claim. A reply or a forward is, structurally, a
    // continuation of something already under way — so the thread prefix is
    // enough to call it a follow-up. Applied only as a fallback: where a
    // category *did* win, "Re: Website revamp invoice" should stay a Task.
    if (/^\s*(re|fwd|fw)\s*:/i.test(subject)) return "Follow-ups";
    return undefined;
  }

  // `id` is typed as string on Intent, so confirm it against the allow-list
  // rather than asserting — a typo in RULES would otherwise ship a category
  // that no chip can ever match.
  return MSG_CATEGORIES.find((c) => c === top.id);
}
