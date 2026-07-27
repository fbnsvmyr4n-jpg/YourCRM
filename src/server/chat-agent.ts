import { STAGES } from "@/data/deals";
import { listContacts } from "./contacts-repo";
import { listDeals } from "./deals-repo";
import { listLeads } from "./leads-repo";
import { listMeetings } from "./meetings-repo";
import { listMessages } from "./inbox-repo";
import type { ChatMessage } from "./chat-repo";

const MODEL = "claude-opus-4-8";

function money(n: number) {
  return `$${Math.round(n).toLocaleString()}`;
}

/** A compact, factual snapshot of the whole CRM for the agent to reason over. */
export async function buildCrmContext() {
  const [contacts, leads, deals, meetings, messages] = await Promise.all([
    listContacts(),
    listLeads(),
    listDeals(),
    listMeetings(),
    listMessages(),
  ]);

  const openLeads = leads.filter((l) => l.status === "Follow-up Required");
  const wonDeals = deals.filter((d) => d.stage === "won");
  const openDeals = deals.filter((d) => d.stage !== "won");
  const openValue = openDeals.reduce((s, d) => s + d.value, 0);
  const wonValue = wonDeals.reduce((s, d) => s + d.value, 0);
  const todayMeetings = meetings.filter((m) => m.when === "Today");
  const unread = messages.filter((m) => m.unread && !m.trashed);

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
      const client = new Anthropic();

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
/* ------------------------------------------------------------------ */

function localAnswer(question: string, ctx: CrmContext): string {
  const q = question.toLowerCase();
  const has = (...words: string[]) => words.some((w) => q.includes(w));

  // Pipeline / revenue
  if (has("pipeline", "worth", "revenue", "forecast", "value")) {
    const lines = ctx.byStage.map(
      (s) => `• ${s.stage}: ${s.count} deal${s.count === 1 ? "" : "s"} — ${money(s.value)}`
    );
    return [
      `Your open pipeline is **${money(ctx.openValue)}** across ${ctx.openDeals.length} active deals, with **${money(ctx.wonValue)}** already closed won.`,
      "",
      ...lines,
      "",
      ctx.openDeals.length
        ? `Biggest open deal: ${[...ctx.openDeals].sort((a, b) => b.value - a.value)[0].title} (${money([...ctx.openDeals].sort((a, b) => b.value - a.value)[0].value)}).`
        : "No open deals right now.",
    ].join("\n");
  }

  // Follow-ups
  if (has("follow", "chase", "who should i", "next action", "todo", "to do")) {
    if (!ctx.openLeads.length) return "You're all caught up — no leads are marked for follow-up. 🎉";
    return [
      `You have **${ctx.openLeads.length} lead${ctx.openLeads.length === 1 ? "" : "s"}** needing follow-up:`,
      "",
      ...ctx.openLeads.map((l) => `• **${l.name}** — ${l.company} (via ${l.source}) — ${l.phone}`),
      "",
      `Start with ${ctx.openLeads[0].name}.`,
    ].join("\n");
  }

  // Today / meetings / schedule
  if (has("today", "meeting", "schedule", "calendar", "diary")) {
    if (!ctx.meetings.length) return "Nothing scheduled at the moment.";
    const today = ctx.todayMeetings;
    return [
      today.length
        ? `You have **${today.length} meeting${today.length === 1 ? "" : "s"} today**:`
        : "Nothing today. Coming up:",
      "",
      ...(today.length ? today : ctx.meetings.slice(0, 4)).map(
        (m) => `• **${m.time}** — ${m.name} (${m.company}) — ${m.topic} · ${m.type} · ${m.status}`
      ),
    ].join("\n");
  }

  // Leads
  if (has("lead")) {
    return [
      `You have **${ctx.leads.length} leads** — ${ctx.openLeads.length} needing follow-up, ${ctx.leads.length - ctx.openLeads.length} closed.`,
      "",
      ...ctx.leads.map((l) => `• **${l.name}** — ${l.company} — ${l.status} (${l.source})`),
    ].join("\n");
  }

  // Contacts / clients
  if (has("contact", "client", "customer", "people")) {
    const clients = ctx.contacts.filter((c) => c.type === "client");
    return [
      `You have **${ctx.contacts.length} contacts** — ${clients.length} clients and ${ctx.contacts.length - clients.length} leads.`,
      "",
      ...ctx.contacts.map((c) => `• **${c.firstName} ${c.lastName}** — ${c.company} (${c.type}, ${c.status})`),
    ].join("\n");
  }

  // Deals
  if (has("deal", "close", "won", "kanban")) {
    return [
      `**${ctx.deals.length} deals** — ${ctx.wonDeals.length} won (${money(ctx.wonValue)}), ${ctx.openDeals.length} open (${money(ctx.openValue)}).`,
      "",
      ...[...ctx.deals]
        .sort((a, b) => b.value - a.value)
        .slice(0, 6)
        .map((d) => `• **${d.title}** — ${d.contact}, ${money(d.value)} — ${d.stage}`),
    ].join("\n");
  }

  // Inbox
  if (has("inbox", "message", "email", "unread")) {
    return ctx.unread.length
      ? [
          `You have **${ctx.unread.length} unread message${ctx.unread.length === 1 ? "" : "s"}**:`,
          "",
          ...ctx.unread.map((m) => `• **${m.name}** — ${m.subject}`),
        ].join("\n")
      : "Inbox zero — nothing unread. 🎉";
  }

  // Summary / overview
  if (has("summary", "overview", "how am i", "status", "brief", "hello", "hi ", "hey")) {
    return [
      "Here's where things stand:",
      "",
      `• **Pipeline:** ${money(ctx.openValue)} open across ${ctx.openDeals.length} deals · ${money(ctx.wonValue)} won`,
      `• **Leads:** ${ctx.openLeads.length} need follow-up (of ${ctx.leads.length})`,
      `• **Today:** ${ctx.todayMeetings.length} meeting${ctx.todayMeetings.length === 1 ? "" : "s"}`,
      `• **Inbox:** ${ctx.unread.length} unread`,
      `• **Contacts:** ${ctx.contacts.length}`,
      "",
      ctx.openLeads.length ? `Suggested next step: follow up with ${ctx.openLeads[0].name}.` : "You're all caught up.",
    ].join("\n");
  }

  // Fallback — tell them what it can do, grounded in their real numbers.
  return [
    "I can answer questions about your live CRM data. Try asking:",
    "",
    `• *What's my pipeline worth?* — currently ${money(ctx.openValue)} open`,
    `• *Who should I follow up with?* — ${ctx.openLeads.length} waiting`,
    `• *What's on today?* — ${ctx.todayMeetings.length} meeting${ctx.todayMeetings.length === 1 ? "" : "s"}`,
    "• *Show me my deals* / *my contacts* / *unread messages*",
    "",
    "_Tip: add an `ANTHROPIC_API_KEY` to unlock full conversational AI on this screen._",
  ].join("\n");
}
