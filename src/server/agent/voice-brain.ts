import type Anthropic from "@anthropic-ai/sdk";
import { aiConfigured } from "../ai";
import { getSettings } from "../repos/settings";
import type { TenantQuery } from "../tenant";
import { aiCostMicros, recordUsage } from "../usage";
import type { VoiceSession } from "../voice-agent";
import { invoke, toolsFor, type AgentPrincipal } from "./gateway";
import { CRM_TOOL_REGISTRY } from "./tools";

/**
 * Claude, on the telephone.
 *
 * This replaces a script — `intent → name → company → when → done` — which
 * could take a name and book a slot and could do nothing else. A caller who
 * said "actually, can you tell me what happened to the quote you sent" got the
 * next question in the sequence, because there was no sequence for that.
 *
 * Three constraints shape every decision below, and they are not the ones that
 * shape the chat assistant.
 *
 * **A caller is waiting.** Every second here is silence on a phone line. The
 * model runs at low effort over a small context with a hard timeout, and the
 * greeting is still a fixed string so answering the phone costs nothing.
 *
 * **A caller is an outsider.** The agent reaches the CRM only through the tool
 * gateway, which decides what it may read and write and records every attempt.
 * Nothing here queries the database directly, and there is deliberately no path
 * that could.
 *
 * **The call must survive us.** No key, a timeout, a bad response — any of
 * these falls back to the script rather than dropping the call. A caller
 * hearing a slightly stilted question is a worse experience; a caller hearing
 * silence is a lost customer.
 */

/* Sonnet rather than Opus: this is short-turn conversation over a small
   context, where latency is the dominant cost and nobody is waiting on deep
   reasoning. The same choice, for the same reason, as the chat assistant. */
const MODEL = "claude-sonnet-5";

/**
 * How long the model gets before the script takes over.
 *
 * Twilio holds the call waiting for our TwiML. Twelve seconds of dead air is
 * already past the point where a caller says "hello?" — this is a ceiling that
 * should never be reached, not a target.
 */
const TURN_BUDGET_MS = 8_000;

/** Tool rounds inside one spoken turn. More than this is the agent thinking out
    loud while somebody holds a phone to their ear. */
const MAX_TOOL_ROUNDS = 3;

/** Turns of conversation replayed to the model. A call is short; a transcript
    resent whole on every turn is latency and cost for nothing. */
const HISTORY_TURNS = 12;

export type VoiceReply = { say: string; done: boolean; live: boolean };

function systemPrompt(business: string, callerNumber: string, todayIso: string): string {
  return [
    `You are the receptionist answering the telephone for ${business}. You are speaking out loud to a caller on a phone line.`,
    "",
    "HOW TO SPEAK",
    "Short sentences. One question at a time. No lists, no headings, no markdown — everything you say is read aloud by a speech synthesiser.",
    "Never say an ID, a reference code or an email address unless the caller asks for it specifically.",
    "If you did not hear them properly, say so and ask them to repeat it.",
    "",
    "WHAT YOU MAY DO",
    "You have tools that reach this business's CRM. Use them rather than guessing.",
    "Identify the caller from their number at the start of the call.",
    "You may write a note, record what they are asking about, book a time to speak, and draft a quotation.",
    "",
    "WHAT YOU MUST NEVER DO",
    "Never state a fact about this business's records unless a tool told you it. No prices, no dates, no names, no amounts you were not given.",
    "Never say something has been done unless the tool said it succeeded. If a tool fails, tell the caller plainly that you could not do it.",
    "Never invent a price. Quotations are priced from the price list by the tool, and you cannot set an amount yourself.",
    "A quotation you draft is NOT sent — somebody here reviews it first. Tell the caller that is what happens; never promise it is on its way.",
    "Before you create a person or book a time, say back what you are about to do and get a clear yes. Only then call the tool with confirmed set to true.",
    "If the caller asks for a person, or is upset, or wants something you have no tool for, say you will pass it on and take a message.",
    "",
    `The caller is ringing from ${callerNumber}. Today is ${todayIso}.`,
    "",
    "Say goodbye and stop when the caller's business is finished. Keep the call moving.",
  ].join("\n");
}

/**
 * Take one turn.
 *
 * Returns what to say and whether to hang up. `live` reports whether the model
 * actually answered, so the caller of this function can fall back without
 * having to guess why the text looks the way it does.
 */
export async function speak(
  q: TenantQuery,
  principal: AgentPrincipal,
  session: VoiceSession,
  heard: string
): Promise<VoiceReply | null> {
  if (!aiConfigured()) return null;

  const tools = toolsFor(CRM_TOOL_REGISTRY, principal);
  const { timeZone } = await getSettings(q);
  const today =
    new Date().toLocaleDateString("en-CA", { timeZone }) /* YYYY-MM-DD in the business's zone */;

  /*
     The conversation, rebuilt from what was said rather than from stored model
     messages.

     Storing raw assistant turns — thinking blocks, tool_use blocks — would mean
     the session JSON grows with every tool call and has to survive a schema the
     SDK owns. What the model actually needs is the dialogue; the tool results
     it already acted on are reflected in what it said afterwards.
  */
  const history: Anthropic.MessageParam[] = session.transcript
    .slice(-HISTORY_TURNS)
    .map((turn) => ({
      role: turn.speaker === "Agent" ? ("assistant" as const) : ("user" as const),
      content: turn.text,
    }));
  history.push({ role: "user", content: heard || "(the caller said nothing)" });

  const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
  const client = new AnthropicClient({ timeout: TURN_BUDGET_MS, maxRetries: 0 });

  let inputTokens = 0;
  let outputTokens = 0;
  let said = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      thinking: { type: "adaptive" },
      /* Low, deliberately. A caller is waiting, and this is conversation over a
         handful of facts rather than a problem to reason about. */
      output_config: { effort: "low" },
      tools,
      system: systemPrompt(session.company ?? "this business", session.from, today),
      messages: history,
    });

    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;

    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (text) said = said ? `${said} ${text}` : text;

    const calls = response.content.filter(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use"
    );
    if (calls.length === 0) break;

    /* The assistant turn goes back unchanged, thinking blocks included — the
       same rule the chat loop follows, and for the same reason. */
    history.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const args = (call.input ?? {}) as Record<string, unknown>;
      const execution = await invoke(q, CRM_TOOL_REGISTRY, principal, {
        tool: call.name,
        input: args,
        /* The model's own id for this call. Stable if Twilio redelivers the
           same turn, different between turns — which is exactly the shape an
           idempotency key needs. */
        actionId: call.id,
        confirmed: args.confirmed === true,
      });

      /* The model is told the truth about what happened, including a refusal.
         Dressing a refusal up as a success is how an agent ends up telling
         somebody their meeting is booked when it is not. */
      const content =
        execution.status === "succeeded"
          ? JSON.stringify(execution.value)
          : `This did not happen. ${execution.error}`;

      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content,
        is_error: execution.status !== "succeeded",
      });
    }
    history.push({ role: "user", content: results });
  }

  await recordUsage(q, {
    kind: "ai_message",
    quantity: 1,
    costMicros: aiCostMicros(inputTokens, outputTokens),
    detail: { model: MODEL, inputTokens, outputTokens, surface: "voice" },
  });

  if (!said) return null;

  /*
     Whether the call is over.

     Read from what the agent SAID rather than asked of the model as a separate
     field, because a farewell is a thing you can hear and an extra structured
     output is another round trip while somebody waits. Conservative on purpose:
     mishearing a goodbye and hanging up on a caller mid-sentence is far worse
     than one extra "anything else?".
  */
  const done = /\b(goodbye|good bye|bye now|have a good day|have a great day|take care)\b/i.test(said);

  return { say: said, done, live: true };
}
