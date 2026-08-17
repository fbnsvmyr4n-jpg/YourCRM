import { STAGES } from "@/data/deals";
import { listContacts } from "./contacts-repo";
import { listDeals } from "./deals-repo";
import { listLeads } from "./leads-repo";
import { listMeetings } from "./meetings-repo";
import { listMessages } from "./inbox-repo";
import type { ChatMessage } from "./chat-repo";
import { listCalls } from "./calls-repo";
import { getSettings } from "./settings-repo";
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
export async function buildCrmContext() {
  const [contacts, leads, deals, meetings, messages, calls, settings] = await Promise.all([
    listContacts(),
    listLeads(),
    listDeals(),
    listMeetings(),
    listMessages(),
    listCalls(),
    getSettings(),
  ]);

  const openLeads = leads.filter((l) => l.status === "Follow-up Required");
  const wonDeals = deals.filter((d) => d.stage === "won");
  const openDeals = deals.filter((d) => d.stage !== "won");
  const openValue = openDeals.reduce((s, d) => s + d.value, 0);
  const wonValue = wonDeals.reduce((s, d) => s + d.value, 0);
  const todayMeetings = meetings.filter((m) => m.when === "Today");
  const unread = messages.filter((m) => m.unread && !m.trashed);

  // Progress against target is computed exactly the way the Sales Target page
  // computes it — same source, same month boundary — so the assistant can never
  // quote a number that disagrees with the screen the user is looking at.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const wonThisMonth = wonDeals
    .filter((d) => d.wonAt && Date.parse(d.wonAt) >= monthStart.getTime())
    .reduce((sum, d) => sum + d.value, 0);

  const byStage = STAGES.map((s) => {
    const rows = deals.filter((d) => d.stage === s.id);
    return {
      stage: s.label,
      count: rows.length,
      value: rows.reduce((a, d) => a + d.value, 0),
    };
  });

  return {
    contacts,
    leads,
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
    monthlyTarget: settings.monthlyTarget,
    wonThisMonth,
    /** Every stored file, flattened so a question can name one directly. */
    attachments: messages
      .filter((m) => !m.trashed)
      .flatMap((m) =>
        m.attachments.map((a) => ({
          name: a.name,
          kind: a.kind,
          size: a.size,
          content: a.content,
          from: m.name,
          subject: m.subject,
        }))
      ),
    /** Rendered for the model as a factual briefing. */
    text: [
      `CONTACTS (${contacts.length}): ${contacts
        .map((c) => `${c.firstName} ${c.lastName} [${c.type}, ${c.status}] @ ${c.company}`)
        .join("; ")}`,
      `LEADS (${leads.length}): ${leads
        .map((l) => `${l.name} @ ${l.company} — ${l.status}, source ${l.source}`)
        .join("; ")}`,
      `DEALS (${deals.length}) — open pipeline ${money(openValue)}, closed won ${money(wonValue)}:`,
      deals
        .map((d) => `  • ${d.title} — ${d.contact} @ ${d.company}, ${money(d.value)}, stage ${d.stage}, closes ${d.closeDate}`)
        .join("\n"),
      `PIPELINE BY STAGE: ${byStage.map((s) => `${s.stage}: ${s.count} deals / ${money(s.value)}`).join("; ")}`,
      `MEETINGS (${meetings.length}): ${meetings
        .map((m) => `${m.when} ${m.time} — ${m.name} (${m.company}) re: ${m.topic} [${m.status}, ${m.type}]`)
        .join("; ")}`,
      `INBOX: ${messages.filter((m) => !m.trashed).length} messages, ${unread.length} unread${
        unread.length ? ` (from ${unread.map((m) => m.name).join(", ")})` : ""
      }`,
      `CALLS (${calls.length}), ${calls.filter((c) => c.status === "pending").length} awaiting action: ${calls
        .map((c) => `${c.callerName} (${c.company}) — ${c.outcome}, ${c.status}`)
        .join("; ")}`,
      `TARGET: ${money(wonThisMonth)} won this month against a ${money(settings.monthlyTarget)} monthly target`,
      // Full text, not just filenames — the user asks the assistant to explain
      // what is *in* a document, which it cannot do from a name.
      ...messages
        .filter((m) => !m.trashed && m.attachments.some((a) => a.content))
        .map((m) =>
          m.attachments
            .filter((a) => a.content)
            .map(
              (a) =>
                `ATTACHMENT "${a.name}" (${a.size}, from ${m.name}, re: ${m.subject}):\n${a.content}`
            )
            .join("\n\n")
        ),
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
  question: string,
  history: ChatMessage[]
): Promise<{ text: string; live: boolean }> {
  const ctx = await buildCrmContext();

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      // The SDK defaults to roughly a 10-minute timeout, which in a chat box
      // is indistinguishable from a hang. One retry, then fall back to the
      // deterministic assistant rather than leaving the user waiting.
      const client = new Anthropic({ timeout: 30_000, maxRetries: 1 });

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        thinking: { type: "adaptive" },
        // Chat is latency-sensitive and these are lookup-style questions.
        output_config: { effort: "low" },
        system: [
          "You are the assistant inside YourCRM, a sales CRM. You help Lang Lee (Admin) run their pipeline.",
          "Answer using ONLY the CRM data below. If something isn't in the data, say so plainly rather than inventing it.",
          "Be concise and practical — lead with the answer, then a short supporting detail. Use the person's real names and figures.",
          "When it helps, suggest the next action (who to follow up with, what to close).",
          "",
          "=== LIVE CRM DATA ===",
          ctx.text,
        ].join("\n"),
        messages: [
          ...history.slice(-8).map((m) => ({
            role: m.role,
            content: m.text,
          })),
          { role: "user" as const, content: question },
        ],
      });

      const text = response.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      if (text) return { text, live: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      return {
        text: `I couldn't reach the AI service just now (${detail}). Here's what I can tell you from your data:\n\n${localAnswer(question, ctx)}`,
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
  // A named file beats everything: "what's in Proposal.pdf" is a question about
  // that document, not about proposals in general. Checked first because the
  // filename usually contains a word that would otherwise match a topic.
  const file = findEntity(question, ctx.attachments, (a) => a.name.replace(/\.\w+$/, ""));
  if (file) {
    if (!file.content) {
      return `**${file.name}** (${file.size}) came from ${file.from}, but no readable text is stored for it — so I can't tell you what's inside.`;
    }
    return [
      `**${file.name}** — from ${file.from}, re: ${file.subject}`,
      "",
      // The document itself, not a paraphrase. Without a model available this
      // is the honest thing to hand back: everything it actually says.
      file.content,
    ].join("\n");
  }

  const contact = findEntity(question, ctx.contacts, (c) => `${c.firstName} ${c.lastName} ${c.company}`);
  if (contact) {
    const deals = ctx.deals.filter((d) => d.contact.toLowerCase() === `${contact.firstName} ${contact.lastName}`.toLowerCase());
    const meetings = ctx.meetings.filter((m) => m.name.toLowerCase() === `${contact.firstName} ${contact.lastName}`.toLowerCase());
    return [
      `**${contact.firstName} ${contact.lastName}** — ${contact.company}`,
      `• ${contact.type === "client" ? "Client" : "Lead"} · status ${contact.status}`,
      contact.email ? `• ${contact.email}` : null,
      contact.phone ? `• ${contact.phone}` : null,
      deals.length ? `• ${deals.length} deal${deals.length === 1 ? "" : "s"}: ${deals.map((d) => `${d.title} (${money(d.value)}, ${d.stage})`).join(", ")}` : "• No deals yet",
      meetings.length ? `• ${meetings.length} meeting${meetings.length === 1 ? "" : "s"} booked` : null,
    ].filter(Boolean).join("\n");
  }

  const lead = findEntity(question, ctx.leads, (l) => `${l.name} ${l.company}`);
  if (lead) {
    return [
      `**${lead.name}** — ${lead.company}`,
      `• Lead · ${lead.status} · via ${lead.source}`,
      lead.email ? `• ${lead.email}` : null,
      lead.phone ? `• ${lead.phone}` : null,
      lead.location && lead.location !== "—" ? `• ${lead.location}` : null,
    ].filter(Boolean).join("\n");
  }

  const deal = findEntity(question, ctx.deals, (d) => `${d.title} ${d.contact} ${d.company}`);
  if (deal) {
    return [
      `**${deal.title}** — ${money(deal.value)}`,
      `• ${deal.contact} at ${deal.company}`,
      `• Stage: ${deal.stage}`,
      deal.closeDate && deal.closeDate !== "—" ? `• Expected close: ${deal.closeDate}` : null,
    ].filter(Boolean).join("\n");
  }

  return null;
}

function answerFor(id: string, ctx: CrmContext): string {
  switch (id) {
    case "pipeline": {
      const sorted = [...ctx.openDeals].sort((a, b) => b.value - a.value);
      return [
        `Your open pipeline is **${money(ctx.openValue)}** across ${ctx.openDeals.length} active deal${ctx.openDeals.length === 1 ? "" : "s"}, with **${money(ctx.wonValue)}** already closed won.`,
        "",
        ...ctx.byStage.map((s) => `• ${s.stage}: ${s.count} deal${s.count === 1 ? "" : "s"} — ${money(s.value)}`),
        "",
        sorted.length ? `Biggest open deal: ${sorted[0].title} (${money(sorted[0].value)}).` : "No open deals right now.",
      ].join("\n");
    }

    case "followups":
      if (!ctx.openLeads.length) return "You're all caught up — no leads are marked for follow-up. 🎉";
      return [
        `You have **${ctx.openLeads.length} lead${ctx.openLeads.length === 1 ? "" : "s"}** needing follow-up:`,
        "",
        ...ctx.openLeads.map((l) => `• **${l.name}** — ${l.company} (via ${l.source})${l.phone ? ` — ${l.phone}` : ""}`),
        "",
        `Start with ${ctx.openLeads[0].name}.`,
      ].join("\n");

    case "meetings": {
      if (!ctx.meetings.length) return "Nothing scheduled at the moment.";
      const today = ctx.todayMeetings;
      return [
        today.length
          ? `You have **${today.length} meeting${today.length === 1 ? "" : "s"} today**:`
          : "Nothing today. Coming up:",
        "",
        ...(today.length ? today : ctx.meetings.slice(0, 5)).map(
          (m) => `• **${m.time}** — ${m.name} (${m.company}) — ${m.topic} · ${m.type}`
        ),
      ].join("\n");
    }

    case "leads":
      if (!ctx.leads.length) return "No leads yet.";
      return [
        `You have **${ctx.leads.length} lead${ctx.leads.length === 1 ? "" : "s"}** — ${ctx.openLeads.length} needing follow-up, ${ctx.leads.length - ctx.openLeads.length} closed.`,
        "",
        ...ctx.leads.slice(0, 10).map((l) => `• **${l.name}** — ${l.company} — ${l.status} (${l.source})`),
      ].join("\n");

    case "contacts": {
      const clients = ctx.contacts.filter((c) => c.type === "client");
      if (!ctx.contacts.length) return "No contacts yet.";
      return [
        `You have **${ctx.contacts.length} contact${ctx.contacts.length === 1 ? "" : "s"}** — ${clients.length} client${clients.length === 1 ? "" : "s"} and ${ctx.contacts.length - clients.length} lead${ctx.contacts.length - clients.length === 1 ? "" : "s"}.`,
        "",
        ...ctx.contacts.slice(0, 10).map((c) => `• **${c.firstName} ${c.lastName}** — ${c.company} (${c.type}, ${c.status})`),
      ].join("\n");
    }

    case "deals":
      if (!ctx.deals.length) return "No deals on the board yet.";
      return [
        `**${ctx.deals.length} deal${ctx.deals.length === 1 ? "" : "s"}** — ${ctx.wonDeals.length} won (${money(ctx.wonValue)}), ${ctx.openDeals.length} open (${money(ctx.openValue)}).`,
        "",
        ...[...ctx.deals].sort((a, b) => b.value - a.value).slice(0, 6)
          .map((d) => `• **${d.title}** — ${d.contact}, ${money(d.value)} — ${d.stage}`),
      ].join("\n");

    case "inbox":
      return ctx.unread.length
        ? [
            `You have **${ctx.unread.length} unread message${ctx.unread.length === 1 ? "" : "s"}**:`,
            "",
            ...ctx.unread.map((m) => `• **${m.name}** — ${m.subject}`),
          ].join("\n")
        : "Inbox zero — nothing unread. 🎉";

    case "calls": {
      const pending = ctx.calls.filter((c) => c.status === "pending");
      if (!ctx.calls.length) return "No calls logged yet.";
      return [
        `**${ctx.calls.length} call${ctx.calls.length === 1 ? "" : "s"}** logged — ${pending.length} still needing to be processed.`,
        "",
        ...ctx.calls.slice(0, 5).map((c) => `• **${c.callerName}** (${c.company}) — ${c.outcome.replace(/-/g, " ")}${c.status === "pending" ? " · needs processing" : ""}`),
      ].join("\n");
    }

    case "attachments": {
      if (!ctx.attachments.length) return "No attachments in your inbox yet.";

      const withText = ctx.attachments.filter((a) => a.content);
      return [
        `**${ctx.attachments.length} attachment${ctx.attachments.length === 1 ? "" : "s"}** in your inbox:`,
        "",
        ...ctx.attachments.map(
          (a) => `• **${a.name}** (${a.size}) — from ${a.from}, re: ${a.subject}`
        ),
        "",
        withText.length
          ? `Ask me about one by name — e.g. *what's in ${withText[0].name}?* — and I'll summarise it.`
          : "None of these have readable text stored, so I can't summarise them.",
      ].join("\n");
    }

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
        `• **Leads:** ${ctx.openLeads.length} need follow-up (of ${ctx.leads.length})`,
        `• **Today:** ${ctx.todayMeetings.length} meeting${ctx.todayMeetings.length === 1 ? "" : "s"}`,
        `• **Inbox:** ${ctx.unread.length} unread`,
        `• **Contacts:** ${ctx.contacts.length}`,
        "",
        ctx.openLeads.length
          ? `Suggested next step: follow up with ${ctx.openLeads[0].name}.`
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
