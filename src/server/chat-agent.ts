/* Type-only: erased at build, so the SDK is still loaded lazily at the one
   place that needs it and a deployment without a key never imports it. */
import type Anthropic from "@anthropic-ai/sdk";
import { aiConfigured } from "./ai";
import { BOARD_STAGES as STAGES } from "@/data/pipeline";
import { listContacts } from "./repos/contacts";
import { listDeals } from "./repos/deals";
import { listMeetings } from "./repos/meetings";
import { listMessages, unreadCount } from "./repos/inbox";
import type { ChatMessage } from "./repos/chat";
import { listCalls } from "./repos/calls";
import { listPriceItems } from "./repos/pricing";
import { quotesAwaitingApproval } from "./repos/quotes";
import { getSettings } from "./repos/settings";
import { QUOTE_TOOLS, quoteInstructions, runQuoteTool } from "./quote-agent";
import { instantToWallClock } from "@/lib/zoned";
import type { TenantQuery } from "./tenant";
import { aiCostMicros, recordUsage } from "./usage";
import { CONFIDENT, findEntity, rankIntents } from "./chat-intents";
import { INTENTS, SUGGESTION_POOL } from "./chat-answers";

// Sonnet 5 rather than Opus: this task is retrieval and summarisation over a
// small CRM snapshot, where latency and cost matter more than peak reasoning.
// The previous value, claude-opus-4-8, was a superseded generation.
const MODEL = "claude-sonnet-5";

function money(n: number) {
  return `$${Math.round(n).toLocaleString()}`;
}

/** A compact, factual snapshot of the whole CRM for the agent to reason over. */
export async function buildCrmContext(q: TenantQuery) {
  const settings = await getSettings(q);
  const contacts = await listContacts(q);
  const deals = await listDeals(q);
  const meetings = await listMeetings(q);
  const messages = await listMessages(q, "inbox");
  const calls = await listCalls(q);
  /* Active items only: a withdrawn rate must not be offered on a new quote,
     and the agent quoting one would be the price list's whole reason for
     existing, defeated. */
  const prices = await listPriceItems(q, true);
  const pendingQuotes = await quotesAwaitingApproval(q);

  // Money arrives in cents and every line below is written for a human, so it
  // is converted once here rather than at each mention.
  const units = (cents: number) => Math.round(cents / 100);

  // A lead is a contact with a deal still in play — the derived definition,
  // so the assistant cannot quote a figure the screens disagree with.
  const openLeads = contacts.filter((c) => c.hasOpenDeal);
  // Won-ness from the recorded fact, so Delivery and Referral still count.
  const wonDeals = deals.filter((d) => d.wonAt !== null);
  const openDeals = deals.filter((d) => ["prospect", "discovery", "demo"].includes(d.stage));
  const openValue = units(openDeals.reduce((s, d) => s + d.valueCents, 0));
  const wonValue = units(wonDeals.reduce((s, d) => s + d.valueCents, 0));

  const todayKey =
    instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
    new Date().toISOString().slice(0, 10);
  const todayMeetings = meetings.filter(
    (m) => instantToWallClock(m.scheduledAt, settings.timeZone)?.date === todayKey
  );
  const unread = await unreadCount(q);

  // Progress against target is computed exactly the way the Sales Target page
  // computes it — same source, same month boundary — so the assistant can never
  // quote a number that disagrees with the screen the user is looking at.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const wonThisMonth = units(
    wonDeals
      .filter((d) => d.wonAt && Date.parse(d.wonAt) >= monthStart.getTime())
      .reduce((sum, d) => sum + d.valueCents, 0)
  );

  const byStage = STAGES.map((s) => {
    const rows = deals.filter((d) => d.stage === s.id);
    return {
      stage: s.label,
      count: rows.length,
      value: units(rows.reduce((a, d) => a + d.valueCents, 0)),
    };
  });

  // Names come from the contact record through the foreign key. The old
  // briefing read a copy of the name stored on each deal and meeting, so a
  // renamed contact appeared under two names in the same paragraph.
  const nameOf = new Map(contacts.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]));
  const who = (id: string | null) => (id ? (nameOf.get(id) ?? "unknown") : "unassigned");

  const monthlyTarget = units(settings.monthlyTargetCents);

  return {
    contacts,
    deals,
    meetings,
    messages,
    openLeads,
    wonDeals,
    openDeals,
    openValue,
    wonValue,
    todayMeetings,
    unread,
    byStage,
    calls,
    prices,
    pendingQuotes,
    /* Whether there is a model behind the assistant at all. The deterministic
       answers below are the ones a user sees when there is not, so they are
       the ones that have to be able to say so. */
    aiLive: aiConfigured(),
    monthlyTarget,
    wonThisMonth,
    /**
     * Rendered for the model as a factual briefing.
     *
     * Attachments used to be flattened in here in full, so the assistant could
     * answer questions about a document's contents. There is no attachment
     * storage in the new schema, so that section is absent rather than empty —
     * claiming to have read a file nobody stored is the failure mode this
     * whole product has been fighting.
     */
    text: [
      `CONTACTS (${contacts.length}): ${contacts
        .map(
          (c) =>
            `${c.firstName} ${c.lastName} [${c.isClient ? "client" : c.hasOpenDeal ? "open deal" : "no open deal"}]${
              c.info ? ` @ ${c.info}` : ""
            }`
        )
        .join("; ")}`,
      `DEALS (${deals.length}) — open pipeline ${money(openValue)}, closed won ${money(wonValue)}:`,
      deals
        .map(
          (d) =>
            `  • ${d.title} — ${who(d.contactId)}, ${money(units(d.valueCents))}, stage ${d.stage}, source ${d.source}${
              d.wonAt ? `, won ${d.wonAt.slice(0, 10)}` : ""
            }${d.painPoints.length ? `, pain points: ${d.painPoints.join(" / ")}` : ""}`
        )
        .join("\n"),
      `PIPELINE BY STAGE: ${byStage.map((s) => `${s.stage}: ${s.count} deals / ${money(s.value)}`).join("; ")}`,
      `MEETINGS (${meetings.length}): ${meetings
        .map((m) => {
          const w = instantToWallClock(m.scheduledAt, settings.timeZone);
          return `${w?.date ?? "?"} ${w?.time ?? ""} — ${who(m.contactId)} re: ${m.topic} [${m.outcome}, ${m.kind}]`;
        })
        .join("; ")}`,
      `INBOX: ${messages.length} messages, ${unread} unread`,
      `CALLS (${calls.length}): ${calls
        .map((c) => `${c.callerName || "unknown caller"} — ${c.outcome ?? "no outcome recorded"}`)
        .join("; ")}`,
      `TARGET: ${money(wonThisMonth)} won this month against a ${money(monthlyTarget)} monthly target`,
      /*
         The price list, verbatim, because it is the only place a quotation's
         figures may come from. Rendered with the unit so a line reads properly
         — "per day" and "each" change what a quantity means — and in dollars
         and cents rather than cents, so 1,200,050 is never repeated to somebody
         as a price.
      */
      prices.length
        ? `PRICE LIST (the ONLY prices you may quote):\n${prices
            .map(
              (p) =>
                `  • ${p.name} — $${(p.unitCents / 100).toFixed(2)} ${p.unit}${
                  p.description ? ` (${p.description})` : ""
                }`
            )
            .join("\n")}`
        : "PRICE LIST: empty — nothing has been priced yet, so no quotation can be drafted.",
      pendingQuotes.length
        ? `QUOTATIONS WAITING FOR THE USER'S APPROVAL:\n${pendingQuotes
            .map(
              (d) =>
                `  • ${d.number} — ${d.projectTitle}${d.party ? ` for ${d.party}` : ""}, ${money(
                  Math.round(d.totalCents / 100)
                )}${d.revision > 0 ? `, revision ${d.revision}` : ""}: ${d.lines
                  .map((l) => `${l.description} ×${l.quantity}`)
                  .join("; ")}`
            )
            .join("\n")}`
        : "QUOTATIONS WAITING FOR APPROVAL: none",
    ].join("\n"),
  };
}

export type CrmContext = Awaited<ReturnType<typeof buildCrmContext>>;

/* ------------------------------------------------------------------ */
/* The agent                                                           */
/* ------------------------------------------------------------------ */

/**
 * Answer a user question about the CRM.
 *
 * With `ANTHROPIC_API_KEY` set, this runs a real Claude agent that reasons
 * over the live CRM snapshot. Without a key it falls back to a deterministic
 * assistant that still answers from real data — so the feature works out of
 * the box and upgrades to a full LLM by adding one environment variable.
 */
export async function answer(
  q: TenantQuery,
  question: string,
  history: ChatMessage[],
  userName: string
): Promise<{ text: string; live: boolean }> {
  const ctx = await buildCrmContext(q);

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
      // The SDK defaults to roughly a 10-minute timeout, which in a chat box
      // is indistinguishable from a hang. One retry, then fall back to the
      // deterministic assistant rather than leaving the user waiting.
      const client = new AnthropicClient({ timeout: 30_000, maxRetries: 1 });

      /* The SDK's own type, not a hand-written one. The conversation now grows
         mid-request — assistant turns with thinking and tool_use blocks, user
         turns carrying tool results — and a local `{role, content}` interface
         would type-check every one of those into a shape the API rejects. */
      const messages: Anthropic.MessageParam[] = [
        ...history.slice(-8).map((m) => ({
          role: m.role,
          content: m.text,
        })),
        { role: "user" as const, content: question },
      ];

      /* Usage is accumulated across the whole exchange rather than read off the
         last response. A message that drafts a quotation is two or three calls
         to the model, and billing the customer's usage for only the last of
         them would under-report exactly the messages that cost the most. */
      let inputTokens = 0;
      let outputTokens = 0;
      let text = "";

      /*
         The tool loop.

         Four iterations: draft, respond to a tool result, revise, respond. More
         than that in one message is a conversation the model is having with
         itself, and each pass is a paid call with a chat box waiting on it. If
         it runs out, whatever text it has produced is what the user gets —
         truncated help, never a silent nothing.
      */
      for (let step = 0; step < 4; step++) {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 1024,
          thinking: { type: "adaptive" },
          // Chat is latency-sensitive and these are lookup-style questions.
          output_config: { effort: "low" },
          tools: QUOTE_TOOLS,
          system: [
            // The name comes from the session. It was hardcoded to "Lang Lee
            // (Admin)", so the assistant addressed every user on every account by
            // one person's name — harmless while there was one user, and a
            // stranger's name on screen the moment there were two.
            `You are the assistant inside YourCRM, a sales CRM. You help ${userName} run their pipeline.`,
            "Answer using ONLY the CRM data below. If something isn't in the data, say so plainly rather than inventing it.",
            "Be concise and practical — lead with the answer, then a short supporting detail. Use the person's real names and figures.",
            "When it helps, suggest the next action (who to follow up with, what to close).",
            "",
            quoteInstructions(),
            "",
            "=== LIVE CRM DATA ===",
            ctx.text,
          ].join("\n"),
          messages,
        });

        inputTokens += response.usage?.input_tokens ?? 0;
        outputTokens += response.usage?.output_tokens ?? 0;

        const said = response.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (said) text = text ? `${text}\n\n${said}` : said;

        const calls = response.content.filter(
          (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use"
        );
        if (calls.length === 0) break;

        /* The assistant turn goes back UNCHANGED, thinking blocks included.
           Rebuilding it from the text would drop them, and a model asked to
           continue from a turn it did not produce is a model that has lost its
           own reasoning halfway through pricing a job. */
        messages.push({ role: "assistant", content: response.content });

        const results = [];
        for (const call of calls) {
          const outcome = await runQuoteTool(q, call.name, call.input, "chat");
          results.push({
            type: "tool_result" as const,
            tool_use_id: call.id,
            content: outcome.text,
          });
        }
        /* All of them in ONE user message. Splitting tool results across
           several messages teaches the model to stop asking for more than one
           thing at a time. */
        messages.push({ role: "user", content: results });
      }

      if (text) {
        /**
         * Metered here, from the response's own token counts, rather than
         * estimated from the question's length.
         *
         * This is the number the pricing question turns on: "unlimited" at $97
         * alongside an assistant billed per token is only sustainable at some
         * usage, and nobody knows what that usage is. Recorded before anything
         * is decided about it — measuring and limiting are separate jobs, and
         * doing the second first means inventing the number twice.
         *
         * `recordUsage` never throws: the customer's answer is already in hand,
         * and losing a bookkeeping row must not cost them it.
         */
        await recordUsage(q, {
          kind: "ai_message",
          quantity: 1,
          costMicros: aiCostMicros(inputTokens, outputTokens),
          // Enough to recompute the cost when the rates change, and nothing
          // about what was asked or answered.
          detail: { model: MODEL, inputTokens, outputTokens },
        });
        return { text, live: true };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      /*
         The fallback must not contradict the sentence above it.
         `aiLive` means "a key is set", which is not the same as "the model
         answered" — with a key present but rejected, the quote answer cheerfully
         offered to draft one immediately below a line saying the AI could not be
         reached. Seen for real: a placeholder left in `.env.local` produced a
         401, and the reply both apologised and volunteered.
      */
      return {
        text: `I couldn't reach the AI service just now (${detail}). Here's what I can tell you from your data:\n\n${localAnswer(question, { ...ctx, aiLive: false })}`,
        live: false,
      };
    }
  }

  return { text: localAnswer(question, ctx), live: false };
}

/* ------------------------------------------------------------------ */
/* Deterministic CRM assistant (no API key required)                   */
/*                                                                     */
/* Scored intent matching over fuzzy tokens, so a typo or a partial    */
/* word still finds its answer, and an unrecognised question says so   */
/* honestly instead of falling through to whichever keyword happened   */
/* to appear first.                                                    */
/* ------------------------------------------------------------------ */

/** A person the user asked about by name, wherever they live in the CRM. */
function describeEntity(question: string, ctx: CrmContext): string | null {
  /**
   * Attachments are no longer answerable, and that is deliberate.
   *
   * The old version flattened every stored file's full text into the context so
   * "what's in Proposal.pdf" could be answered from the document itself. There
   * is no attachment storage in the new schema, so the honest behaviour is to
   * have nothing to say about files rather than to answer from a name — the
   * exact failure this product keeps designing against.
   */
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const units = (cents: number) => Math.round(cents / 100);
  const fullName = (c: { firstName: string; lastName: string }) =>
    `${c.firstName} ${c.lastName}`.trim();

  const contact = findEntity(question, ctx.contacts, (c) => `${fullName(c)} ${c.info ?? ""}`);
  if (contact) {
    // Matched by id, not by comparing names. The old version compared the
    // contact's name to a copy stored on each deal, so renaming somebody
    // emptied their history here as well as everywhere else.
    const deals = ctx.deals.filter((d) => d.contactId === contact.id);
    const meetings = ctx.meetings.filter((m) => m.contactId === contact.id);
    return [
      `**${fullName(contact)}**${contact.info ? ` — ${contact.info}` : ""}`,
      `• ${contact.isClient ? "Client" : contact.hasOpenDeal ? "Open deal in progress" : "No open deal"}`,
      contact.email ? `• ${contact.email}` : null,
      contact.phone ? `• ${contact.phone}` : null,
      deals.length
        ? `• ${deals.length} deal${deals.length === 1 ? "" : "s"}: ${deals
            .map((d) => `${d.title} (${money(units(d.valueCents))}, ${d.stage})`)
            .join(", ")}`
        : "• No deals yet",
      meetings.length ? `• ${meetings.length} meeting${meetings.length === 1 ? "" : "s"} booked` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const deal = findEntity(question, ctx.deals, (d) => d.title);
  if (deal) {
    const person = ctx.contacts.find((c) => c.id === deal.contactId);
    return [
      `**${deal.title}** — ${money(units(deal.valueCents))}`,
      person ? `• ${fullName(person)}${person.info ? ` at ${person.info}` : ""}` : "• Unassigned",
      `• Stage: ${deal.stage}`,
      `• Source: ${deal.source}`,
      // What they said hurts, which is what the demo should be built from.
      deal.painPoints.length ? `• Pain points: ${deal.painPoints.join(" / ")}` : null,
      deal.wonAt ? `• Won ${deal.wonAt.slice(0, 10)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return null;
}

function answerFor(id: string, ctx: CrmContext): string {
  switch (id) {
    case "pipeline": {
      const sorted = [...ctx.openDeals].sort((a, b) => b.valueCents - a.valueCents);
      return [
        `Your open pipeline is **${money(ctx.openValue)}** across ${ctx.openDeals.length} active deal${ctx.openDeals.length === 1 ? "" : "s"}, with **${money(ctx.wonValue)}** already closed won.`,
        "",
        ...ctx.byStage.map((s) => `• ${s.stage}: ${s.count} deal${s.count === 1 ? "" : "s"} — ${money(s.value)}`),
        "",
        sorted.length
          ? `Biggest open deal: ${sorted[0].title} (${money(Math.round(sorted[0].valueCents / 100))}).`
          : "No open deals right now.",
      ].join("\n");
    }

    case "followups":
      if (!ctx.openLeads.length) return "You're all caught up — nobody has a deal waiting on a next step. 🎉";
      return [
        `You have **${ctx.openLeads.length} ${ctx.openLeads.length === 1 ? "person" : "people"}** with a deal in progress:`,
        "",
        // A lead is a contact with an open deal, so these are contacts.
        ...ctx.openLeads.map(
          (l) =>
            `• **${l.firstName} ${l.lastName}**${l.info ? ` — ${l.info}` : ""}${l.phone ? ` — ${l.phone}` : ""}`
        ),
        "",
        `Start with ${ctx.openLeads[0].firstName} ${ctx.openLeads[0].lastName}.`,
      ].join("\n");

    case "meetings": {
      if (!ctx.meetings.length) return "Nothing scheduled at the moment.";
      const today = ctx.todayMeetings;
      return [
        today.length
          ? `You have **${today.length} meeting${today.length === 1 ? "" : "s"} today**:`
          : "Nothing today. Coming up:",
        "",
        ...(today.length ? today : ctx.meetings.slice(0, 5)).map((m) => {
          const person = ctx.contacts.find((c) => c.id === m.contactId);
          const at = new Date(m.scheduledAt).toISOString().slice(11, 16);
          return `• **${at}** — ${person ? `${person.firstName} ${person.lastName}` : "unassigned"} — ${m.topic} · ${m.kind}`;
        }),
      ].join("\n");
    }

    case "leads": {
      // There is no separate lead record any more: a lead is a contact with a
      // deal still in play, so this answers from the people who have one.
      const clients = ctx.contacts.filter((c) => c.isClient).length;
      /* The verb agrees as well as the noun. Pluralising "contact" and leaving
         "have" alone produced "1 contact have bought" on a real account —
         caught in a screen recording, and exactly the kind of seam that makes
         an assistant read as a template rather than as something that looked at
         your data. */
      if (!ctx.openLeads.length) {
        return `No open leads. ${clients} contact${clients === 1 ? " has" : "s have"} bought.`;
      }
      return [
        `You have **${ctx.openLeads.length}** ${ctx.openLeads.length === 1 ? "person" : "people"} with an open deal, and ${clients} who have bought.`,
        "",
        ...ctx.openLeads
          .slice(0, 10)
          .map((l) => `• **${l.firstName} ${l.lastName}**${l.info ? ` — ${l.info}` : ""}`),
      ].join("\n");
    }

    case "contacts": {
      const clients = ctx.contacts.filter((c) => c.isClient);
      if (!ctx.contacts.length) return "No contacts yet.";
      return [
        `You have **${ctx.contacts.length} contact${ctx.contacts.length === 1 ? "" : "s"}** — ${clients.length} client${clients.length === 1 ? "" : "s"} and ${ctx.contacts.length - clients.length} lead${ctx.contacts.length - clients.length === 1 ? "" : "s"}.`,
        "",
        ...ctx.contacts
          .slice(0, 10)
          .map(
            (c) =>
              `• **${c.firstName} ${c.lastName}**${c.info ? ` — ${c.info}` : ""} (${
                c.isClient ? "client" : c.hasOpenDeal ? "open deal" : "no open deal"
              })`
          ),
      ].join("\n");
    }

    case "deals":
      if (!ctx.deals.length) return "No deals on the board yet.";
      return [
        `**${ctx.deals.length} deal${ctx.deals.length === 1 ? "" : "s"}** — ${ctx.wonDeals.length} won (${money(ctx.wonValue)}), ${ctx.openDeals.length} open (${money(ctx.openValue)}).`,
        "",
        ...[...ctx.deals]
          .sort((a, b) => b.valueCents - a.valueCents)
          .slice(0, 6)
          .map((d) => {
            const person = ctx.contacts.find((c) => c.id === d.contactId);
            const who = person ? `${person.firstName} ${person.lastName}` : "unassigned";
            return `• **${d.title}** — ${who}, ${money(Math.round(d.valueCents / 100))} — ${d.stage}`;
          }),
      ].join("\n");

    case "inbox":
      // `unread` is a count from the database rather than a list length, so it
      // agrees with the badge in the sidebar instead of being derived twice.
      return ctx.unread > 0
        ? `You have **${ctx.unread} unread message${ctx.unread === 1 ? "" : "s"}** waiting in your inbox.`
        : "Inbox zero — nothing unread. 🎉";

    case "calls": {
      // "Pending" is a call nobody has recorded an outcome for — the same
      // rule meetings follow, rather than a stored status that could disagree.
      const pending = ctx.calls.filter((c) => !c.outcome);
      if (!ctx.calls.length) return "No calls logged yet.";
      return [
        `**${ctx.calls.length} call${ctx.calls.length === 1 ? "" : "s"}** logged — ${pending.length} still needing to be processed.`,
        "",
        ...ctx.calls
          .slice(0, 5)
          .map(
            (c) =>
              `• **${c.callerName || "unknown caller"}** — ${
                c.outcome ? c.outcome.replace(/-/g, " ") : "no outcome recorded · needs processing"
              }`
          ),
      ].join("\n");
    }

    case "quote": {
      /**
       * Why a quotation cannot be drafted, when it cannot.
       *
       * This branch only runs on the deterministic assistant — the live agent
       * has tools and does the work — so reaching it means something is
       * missing, and the useful answer names WHICH thing. Before this existed
       * the request fell through to "I'm not sure what you're after", which is
       * how a feature that is merely switched off looks broken.
       */
      const priced = ctx.prices.length;
      const waiting = ctx.pendingQuotes.length;

      if (!ctx.aiLive) {
        return [
          "I can't draft quotations at the moment — the AI assistant isn't switched on for this workspace, so I'm answering from your data only.",
          "",
          "An owner can turn it on by setting an Anthropic API key on the deployment. Once it is on, I can build a quote from your price list and put it in front of you to approve.",
          priced
            ? `Your price list has ${priced} item${priced === 1 ? "" : "s"} ready for it.`
            : "You'll also want some prices on the Price list page — that is where a quote's figures come from.",
        ].join("\n");
      }

      if (!priced) {
        return [
          "I can draft quotations, but your price list is empty — and every figure on a quote comes from it, so there is nothing for me to build one out of.",
          "",
          "Add what you sell on the Price list page — a name, a unit and a rate — and then ask me again.",
        ].join("\n");
      }

      return [
        `I can draft a quotation from your price list (${priced} item${priced === 1 ? "" : "s"}).`,
        "",
        "Tell me the project and what goes on it — something like *quote the Heineken rebuild for three days of crane hire*. I'll put it in front of you to approve; nothing goes to a client until you say so.",
        waiting ? `\nYou have ${waiting} quotation${waiting === 1 ? "" : "s"} waiting for approval.` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "attachments":
      /**
       * Answered honestly rather than removed.
       *
       * The intent still exists — somebody will ask about a file — and the
       * truthful answer is that nothing stores one. Silently dropping the case
       * would fall through to whichever keyword matched next and produce a
       * confident answer to a different question.
       */
      return "I can't help with attachments yet — files aren't stored anywhere in the CRM, so there's nothing for me to read.";

    case "performance": {
      const closable = ctx.deals.length;
      const winRate = closable ? Math.round((ctx.wonDeals.length / closable) * 100) : null;
      const avg = ctx.wonDeals.length ? ctx.wonValue / ctx.wonDeals.length : 0;
      return [
        "How you're performing:",
        "",
        `• **Win rate:** ${winRate === null ? "—" : `${winRate}%`} (${ctx.wonDeals.length} won of ${closable} deals)`,
        `• **Revenue won:** ${money(ctx.wonValue)}`,
        `• **Average deal size:** ${ctx.wonDeals.length ? money(avg) : "—"}`,
        `• **Open pipeline:** ${money(ctx.openValue)}`,
      ].join("\n");
    }

    case "target": {
      const pct = ctx.monthlyTarget > 0 ? Math.round((ctx.wonThisMonth / ctx.monthlyTarget) * 100) : 0;
      const left = Math.max(0, ctx.monthlyTarget - ctx.wonThisMonth);
      return [
        `You're at **${money(ctx.wonThisMonth)}** of your **${money(ctx.monthlyTarget)}** monthly target — **${pct}%**.`,
        "",
        left > 0
          ? `${money(left)} to go. Your open pipeline is ${money(ctx.openValue)}, so there's ${ctx.openValue >= left ? "enough" : "not quite enough"} in play to cover it.`
          : "Target hit. 🎉",
      ].join("\n");
    }

    case "help":
      return [
        "I can answer anything grounded in your live CRM data. For example:",
        "",
        "• *What's my pipeline worth?* · *Am I on target?* · *What's my win rate?*",
        "• *Who should I follow up with?* · *What's on today?*",
        "• *Show me my deals / contacts / leads / unread messages*",
        "• *Any calls needing attention?*",
        "",
        "You can also ask about a specific person or deal by name — try *tell me about " +
          (ctx.contacts[0] ? `${ctx.contacts[0].firstName} ${ctx.contacts[0].lastName}` : "a contact") +
          "*.",
      ].join("\n");

    case "summary":
    default:
      return [
        "Here's where things stand:",
        "",
        `• **Pipeline:** ${money(ctx.openValue)} open across ${ctx.openDeals.length} deal${ctx.openDeals.length === 1 ? "" : "s"} · ${money(ctx.wonValue)} won`,
        `• **Leads:** ${ctx.openLeads.length} with an open deal (of ${ctx.contacts.length} contacts)`,
        `• **Today:** ${ctx.todayMeetings.length} meeting${ctx.todayMeetings.length === 1 ? "" : "s"}`,
        `• **Inbox:** ${ctx.unread} unread`,
        `• **Contacts:** ${ctx.contacts.length}`,
        "",
        ctx.openLeads.length
          ? `Suggested next step: follow up with ${ctx.openLeads[0].firstName} ${ctx.openLeads[0].lastName}.`
          : "You're all caught up.",
      ].join("\n");
  }
}

function localAnswer(question: string, ctx: CrmContext): string {
  // A named person, company or deal beats a topic — "how is Alex Carter doing"
  // is a question about Alex, not about contacts in general.
  const entity = describeEntity(question, ctx);
  if (entity) return entity;

  const ranked = rankIntents(question, INTENTS);
  const best = ranked[0];

  if (best && best.score >= CONFIDENT) return answerFor(best.id, ctx);

  // Weak match: offer the closest readings rather than confidently answering
  // the wrong question. Guessing is worse than asking.
  const near = ranked.slice(0, 3).filter((m) => m.score > 0.2);
  if (near.length) {
    const labels = near
      .map((m) => SUGGESTION_POOL.find((s) => s.intent === m.id)?.label)
      .filter(Boolean) as string[];
    if (labels.length) {
      return [
        "I'm not certain what you're after. Did you mean:",
        "",
        ...labels.map((l) => `• *${l}*`),
      ].join("\n");
    }
  }

  return answerFor("help", ctx);
}
