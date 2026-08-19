import { MEETING_WHENS, type MeetingWhen } from "@/data/meetings";
import { rankIntents, type Intent } from "./chat-intents";
import { withSystem } from "./tenant";

/**
 * What the agent says to a real caller, and what it remembers between turns.
 *
 * **This is deliberately not the chat assistant.** That one answers from live
 * CRM data — pipeline values, who owes a follow-up, what Lang has booked. A
 * caller is an outsider, and a webhook is a public endpoint, so wiring the two
 * together would hand anybody who dials the number a read of the whole
 * database. This agent knows nothing about the CRM: it can greet, listen,
 * capture who the caller is, and book a slot. Nothing it says is derived from
 * stored records.
 *
 * Each Twilio turn is a separate HTTP request, so the conversation state has to
 * survive between them — it lives in the store, keyed by the call's SID.
 */


export type VoiceStep = "intent" | "name" | "company" | "when" | "done";

export type VoiceSession = {
  id: string;
  from: string;
  step: VoiceStep;
  callerName?: string;
  company?: string;
  topic?: string;
  wantsMeeting?: boolean;
  requestedWhen?: MeetingWhen;
  requestedTime?: string;
  transcript: { speaker: "Agent" | "Caller"; text: string }[];
  startedAt: string;
};


export async function getSession(id: string): Promise<VoiceSession | null> {
  return withSystem(async (q) => {
    const row = await q.one<{ data: VoiceSession }>(
      `SELECT data FROM voice_sessions WHERE id = $1`,
      [id]
    );
    return row?.data ?? null;
  });
}

/**
 * Create-or-update in one statement, so two rapid turns cannot clobber each
 * other.
 *
 * The previous version read every session into memory, edited the array and
 * wrote it back under an advisory lock. An upsert on a primary key does the
 * same job without loading anybody else's call, and without a lock that every
 * concurrent call had to queue behind.
 */
export async function saveSession(session: VoiceSession): Promise<void> {
  await withSystem((q) =>
    q.rows(
      `INSERT INTO voice_sessions (id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [session.id, JSON.stringify(session)]
    )
  );
}

export async function endSession(id: string): Promise<void> {
  await withSystem(async (q) => {
    await q.rows(`DELETE FROM voice_sessions WHERE id = $1`, [id]);
    // A provider does not always send a final status callback, so abandoned
    // calls would otherwise accumulate forever. Anything untouched for a day
    // is not a live conversation.
    await q.rows(`DELETE FROM voice_sessions WHERE updated_at < now() - interval '1 day'`);
  });
}

/* ------------------------------------------------------------------ */
/* Understanding the caller                                            */
/* ------------------------------------------------------------------ */

/** Only what a caller might plausibly say — never CRM vocabulary. */
const CALLER_INTENTS: Intent[] = [
  {
    id: "meeting",
    keywords: ["meeting", "demo", "walkthrough", "appointment", "call", "book", "booking", "schedule", "chat", "session"],
    phrases: ["set something up", "see it", "show me"],
  },
  {
    id: "pricing",
    keywords: ["price", "pricing", "cost", "costs", "quote", "expensive", "budget", "plans", "plan"],
    phrases: ["how much"],
  },
  { id: "support", keywords: ["problem", "issue", "broken", "help", "bug", "error", "stuck", "support"] },
  { id: "info", keywords: ["information", "info", "details", "brochure", "learn", "about", "does", "features"] },
];

export function callerIntent(speech: string): string | null {
  const top = rankIntents(speech, CALLER_INTENTS)[0];
  return top && top.score >= 0.4 ? top.id : null;
}

/** Map what the caller said about timing onto a slot the CRM understands. */
export function whenFromSpeech(speech: string): MeetingWhen {
  const s = speech.toLowerCase();
  if (s.includes("today") || s.includes("this afternoon") || s.includes("this morning")) return "Today";
  if (s.includes("tomorrow")) return "Tomorrow";
  return MEETING_WHENS.includes("This Week") ? "This Week" : MEETING_WHENS[0];
}

/**
 * Pull a name out of a spoken reply.
 *
 * People answer "it's Sarah Miller" or "Sarah, from Miller Design" rather than
 * just their name, so strip the common lead-ins and keep it to a couple of
 * words. Anything longer is almost certainly not a name and is better left
 * empty than stored wrong — `processCall` will still capture the number.
 */
export function nameFromSpeech(speech: string): string {
  const cleaned = speech
    .replace(/^(hi|hello|hey|yeah|yes|sure|um|uh)[,\s]+/i, "")
    .replace(/^(it'?s|this is|my name'?s|my name is|i'?m|its)\s+/i, "")
    .replace(/[.,!?]+$/, "")
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 3);
  if (!words.length || words.join(" ").length > 40) return "";
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function companyFromSpeech(speech: string): string {
  const cleaned = speech
    .replace(/^(i'?m |we'?re |it'?s |this is )?(from|with|at)\s+/i, "")
    .replace(/^(the company is|company is|we are)\s+/i, "")
    .replace(/[.,!?]+$/, "")
    .trim();
  return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
}

export function isDecline(speech: string): boolean {
  return /^\s*(no|nope|nah|not (right )?now|no thanks?|that'?s (all|it)|nothing)\b/i.test(speech);
}

/* ------------------------------------------------------------------ */
/* What the agent says                                                 */
/* ------------------------------------------------------------------ */

export const AGENT_NAME = "Aria";

export const GREETING = `Thanks for calling YourCRM — this is ${AGENT_NAME}. How can I help you today?`;

/**
 * Advance the conversation one turn.
 *
 * Returns the updated session and what to say next. Pure apart from the
 * session it is handed, so the whole script can be walked in a test without a
 * phone, a webhook, or a provider account.
 */
export function nextTurn(
  session: VoiceSession,
  speech: string
): { session: VoiceSession, say: string; done: boolean } {
  const said = speech.trim();
  const s: VoiceSession = {
    ...session,
    transcript: said
      ? [...session.transcript, { speaker: "Caller" as const, text: said }]
      : session.transcript,
  };

  const reply = (say: string, patch: Partial<VoiceSession>, done = false) => {
    const updated = { ...s, ...patch, transcript: [...s.transcript, { speaker: "Agent" as const, text: say }] };
    return { session: updated, say, done };
  };

  switch (s.step) {
    case "intent": {
      const intent = callerIntent(said);
      const wantsMeeting = intent === "meeting" || intent === "pricing";

      // Pricing goes to a person rather than a number the agent would have to
      // invent. Support is captured as a message, not answered — guessing at
      // someone's technical problem on the phone is worse than a callback.
      const ack =
        intent === "pricing"
          ? "Happy to help with pricing — the best thing is a quick call with Lang who can put together the right plan."
          : intent === "support"
            ? "Sorry about that. I'll take the details and get Lang onto it straight away."
            : intent === "meeting"
              ? "Of course, I can set that up."
              : "Sure, I can help with that.";

      return reply(`${ack} Can I start with your name?`, {
        step: "name",
        topic: said.slice(0, 120) || undefined,
        wantsMeeting,
      });
    }

    case "name": {
      const name = nameFromSpeech(said);
      return reply(
        name ? `Thanks ${name}. And which company are you with?` : "And which company are you with?",
        { step: "company", callerName: name || s.callerName }
      );
    }

    case "company": {
      const company = companyFromSpeech(said);
      if (s.wantsMeeting) {
        return reply(
          "Got it. When would suit you — tomorrow, or later this week?",
          { step: "when", company: company || s.company }
        );
      }
      return reply(
        `Thank you. I've made a note and Lang will come back to you shortly. Have a great day.`,
        { step: "done", company: company || s.company },
        true
      );
    }

    case "when": {
      const when = whenFromSpeech(said);
      return reply(
        `Perfect — I've pencilled you in for ${when.toLowerCase()} and Lang will confirm the exact time. Thanks for calling.`,
        { step: "done", requestedWhen: when, requestedTime: "10:00 AM" },
        true
      );
    }

    default:
      return reply("Thanks for calling. Goodbye.", { step: "done" }, true);
  }
}

/** What the automation should record once the call ends. */
export function callFromSession(session: VoiceSession, durationSec: number) {
  const outcome = session.requestedWhen
    ? ("meeting-booked" as const)
    : session.callerName
      ? ("qualified" as const)
      : ("message-taken" as const);

  return {
    callerName: session.callerName || "Unknown Caller",
    phone: session.from,
    company: session.company || "—",
    durationSec,
    outcome,
    summary: summarise(session),
    transcript: session.transcript,
    topic: session.topic,
    requestedWhen: session.requestedWhen,
    requestedTime: session.requestedTime,
  };
}

/**
 * A summary built only from what the caller actually said.
 *
 * No model is involved, so there is nothing here that can be embellished — the
 * card on the Voice Agent page is the one thing the user reads to decide what
 * to do next, and it has to be trustworthy.
 */
function summarise(session: VoiceSession): string {
  const who = session.callerName || "Caller";
  const where = session.company && session.company !== "—" ? ` from ${session.company}` : "";
  const asked = session.topic ? ` Asked about: ${session.topic}` : "";
  const booked = session.requestedWhen ? ` Requested a meeting ${session.requestedWhen.toLowerCase()}.` : "";
  return `${who}${where} called in.${asked}${booked}`.replace(/\s+/g, " ").trim();
}
