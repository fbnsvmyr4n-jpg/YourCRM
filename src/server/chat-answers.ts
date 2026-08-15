import { editDistance, rankIntents, type Intent } from "./chat-intents";

/**
 * What the assistant can be asked about.
 *
 * Three rules learned from testing this list, each of which came from a real
 * failure:
 *
 *  1. Include plural and common variants as their own keywords. Typo tolerance
 *     scales with word length, so the 4-letter "lead" gets none — but "leads"
 *     does, and "leds" is one edit from it.
 *  2. Keep genuinely ambiguous words like "today" out of the catch-all. It was
 *     a `summary` keyword, so "what meetings do I have today" answered with a
 *     general briefing instead of the meetings.
 *  3. Weight the catch-all below everything specific, so it only wins when
 *     nothing else has a real claim.
 */
export const INTENTS: Intent[] = [
  {
    id: "pipeline",
    keywords: ["pipeline", "revenue", "forecast", "worth", "value", "money", "income", "earning", "earnings", "sales"],
    phrases: ["how much is my pipeline", "pipeline worth"],
  },
  {
    id: "followups",
    keywords: ["followup", "followups", "follow", "chase", "chasing", "overdue", "outstanding", "nudge", "waiting"],
    phrases: ["who should i call", "who should i follow", "need follow"],
  },
  {
    id: "meetings",
    keywords: ["meeting", "meetings", "schedule", "scheduled", "calendar", "diary", "appointment", "appointments", "booked", "booking"],
    phrases: ["on today", "whats on"],
  },
  {
    id: "leads",
    keywords: ["lead", "leads", "prospect", "prospects", "enquiry", "enquiries", "inquiry", "inquiries"],
  },
  {
    id: "contacts",
    keywords: ["contact", "contacts", "client", "clients", "customer", "customers", "people", "person"],
  },
  {
    id: "deals",
    keywords: ["deal", "deals", "closed", "close", "won", "winning", "negotiation", "negotiations", "proposal", "proposals", "qualified"],
  },
  {
    id: "inbox",
    keywords: ["inbox", "message", "messages", "email", "emails", "unread", "mail"],
  },
  {
    id: "attachments",
    keywords: ["attachment", "attachments", "file", "files", "document", "documents", "pdf", "doc", "invoice", "proposal"],
    phrases: ["what does the", "explain the", "summarise the", "summarize the"],
  },
  {
    id: "calls",
    keywords: ["call", "calls", "voice", "phone", "caller", "voicemail", "agent"],
  },
  {
    id: "performance",
    keywords: ["conversion", "winrate", "rate", "performance", "showrate", "ratio", "percent", "percentage"],
    phrases: ["how am i doing", "win rate", "show rate"],
  },
  {
    id: "target",
    keywords: ["target", "goal", "quota", "progress", "track"],
    phrases: ["on target", "hit my target"],
  },
  {
    id: "help",
    keywords: ["help", "ask", "questions", "capabilities", "able"],
    phrases: ["what can you do", "what can i ask"],
  },
  {
    // The catch-all. Deliberately light on keywords and weighted below the
    // rest, so it wins only when nothing specific does.
    id: "summary",
    keywords: ["summary", "overview", "status", "brief", "briefing", "hello", "hi", "hey", "morning", "everything"],
    weight: 0.72,
  },
];

/** Offered up front and refreshed as the user types. */
export const SUGGESTION_POOL: { label: string; intent: string }[] = [
  { label: "What's my pipeline worth?", intent: "pipeline" },
  { label: "Who should I follow up with?", intent: "followups" },
  { label: "What's on today?", intent: "meetings" },
  { label: "How many leads do I have?", intent: "leads" },
  { label: "Which deals are closest to closing?", intent: "deals" },
  { label: "Any unread messages?", intent: "inbox" },
  { label: "What's in my attachments?", intent: "attachments" },
  { label: "How am I tracking against target?", intent: "target" },
  { label: "What's my win rate?", intent: "performance" },
  { label: "Any calls needing attention?", intent: "calls" },
  { label: "Give me a summary of today", intent: "summary" },
  { label: "Show me my clients", intent: "contacts" },
  { label: "What can I ask you?", intent: "help" },
];

/**
 * Which questions to offer right now.
 *
 * The strip used to be a fixed list that vanished after the first message. It
 * now stays for the whole conversation and earns its place two ways:
 *
 *  • While the user is typing, it becomes autocomplete — "pipe" surfaces
 *    "What's my pipeline worth?", so a half-typed thought is one click from an
 *    answer rather than a sentence away.
 *  • While the box is empty, it suggests what hasn't been asked yet, so it
 *    reads as "what's next" instead of repeating a question just answered.
 *
 * Pure so it can be tested directly, and free of server imports so the client
 * can call it on every keystroke without a round trip.
 */
export function suggestFor(draft: string, asked: string[] = [], limit = 4): string[] {
  const typed = draft.trim();

  if (typed) {
    const hits = rankIntents(typed, INTENTS)
      // Deliberately below the answering threshold: a suggestion only costs a
      // glance, so a loose match is still worth offering.
      .filter((m) => m.score > 0.15)
      .map((m) => SUGGESTION_POOL.find((s) => s.intent === m.id)?.label)
      .filter((l): l is string => !!l);
    if (hits.length) return hits.slice(0, limit);

    // Scoring requires four characters before it will honour a prefix, which is
    // right for answering — "cal" should never confidently trigger a report on
    // calls. But three characters is exactly when autocomplete should be
    // helping, so short fragments get their own pass. Suggesting is cheap;
    // answering the wrong question is not.
    const fragment = typed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).pop();
    if (fragment && fragment.length >= 2) {
      const near = (k: string) =>
        k.startsWith(fragment) ||
        // "led" is a slip for "lead", not a prefix of anything — one edit at
        // three characters or more still reads as the word they meant.
        (fragment.length >= 3 && editDistance(fragment, k, 1) <= 1);

      const prefixed = SUGGESTION_POOL.filter((s) =>
        INTENTS.find((i) => i.id === s.intent)?.keywords.some(near)
      ).map((s) => s.label);
      if (prefixed.length) return prefixed.slice(0, limit);
    }
  }

  // Nothing typed: lead with what this conversation hasn't covered, then top up
  // from the full pool so the strip is never half-empty.
  const fresh = SUGGESTION_POOL.filter((s) => !asked.includes(s.intent));
  const ordered = [...fresh, ...SUGGESTION_POOL.filter((s) => asked.includes(s.intent))];
  return ordered.slice(0, limit).map((s) => s.label);
}

/** The intent a question landed on — used to track what's already been asked. */
export function intentOf(question: string): string | null {
  return rankIntents(question, INTENTS)[0]?.id ?? null;
}
