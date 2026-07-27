"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, RotateCcw, Send, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/Card";
import type { ChatMessage } from "@/server/chat-repo";
import { clsx } from "@/lib/clsx";
import { clearChatAction, sendChatAction } from "./actions";

const SUGGESTIONS = [
  "What's my pipeline worth?",
  "Who should I follow up with?",
  "What's on today?",
  "Give me a summary",
];

/** Minimal markdown: **bold**, *italic*, and `code`. */
function renderText(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded px-1 py-0.5 text-[0.9em]" style={{ background: "var(--raise)" }}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return <span key={i}>{part}</span>;
  });
}

export function ChatView({ messages, aiEnabled }: { messages: ChatMessage[]; aiEnabled: boolean }) {
  const [items, setItems] = useState(messages);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items, busy]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setDraft("");
    setBusy(true);
    // optimistic user bubble
    setItems((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", text: question, at: new Date().toISOString() },
    ]);
    try {
      const res = await sendChatAction(question);
      if (res?.message) setItems((prev) => [...prev, res.message]);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      await clearChatAction();
      setItems((prev) => prev.slice(0, 1));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex h-auto max-w-[900px] animate-fade-up flex-col lg:h-[calc(100vh-104px)]">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 pt-1">
        <div className="flex items-center gap-3">
          <span
            className="relative grid h-11 w-11 shrink-0 place-items-center rounded-2xl"
            style={{ background: "var(--accent-soft)" }}
          >
            <Bot className="h-6 w-6 text-accent" />
            <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--panel-solid)] bg-[var(--green)]" />
          </span>
          <div className="leading-tight">
            <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
              CRM Assistant
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                style={
                  aiEnabled
                    ? { background: "var(--green-soft)", color: "var(--green)" }
                    : { background: "var(--amber-soft)", color: "var(--amber)" }
                }
              >
                {aiEnabled ? "AI CONNECTED" : "DATA MODE"}
              </span>
            </h1>
            <p className="text-xs text-faint">Knows your live pipeline, leads, meetings and inbox.</p>
          </div>
        </div>
        <button
          onClick={reset}
          disabled={busy}
          className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium disabled:opacity-50"
        >
          <RotateCcw className="h-4 w-4" /> New chat
        </button>
      </div>

      {/* Conversation */}
      <Card className="flex min-h-0 flex-1 flex-col !p-0">
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {items.map((m) => (
            <div key={m.id} className={clsx("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              {m.role === "assistant" && (
                <span
                  className="mr-2.5 mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl"
                  style={{ background: "var(--accent-soft)" }}
                >
                  <Sparkles className="h-4 w-4 text-accent" />
                </span>
              )}
              <div
                className={clsx(
                  "max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed",
                  m.role === "user" ? "text-white" : "text-[var(--text)]"
                )}
                style={
                  m.role === "user"
                    ? { backgroundImage: "linear-gradient(135deg,var(--accent-from),var(--accent-to))" }
                    : { background: "var(--raise)" }
                }
              >
                {renderText(m.text)}
              </div>
            </div>
          ))}

          {busy && (
            <div className="flex justify-start">
              <span
                className="mr-2.5 mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl"
                style={{ background: "var(--accent-soft)" }}
              >
                <Sparkles className="h-4 w-4 text-accent" />
              </span>
              <div className="flex items-center gap-1.5 rounded-2xl px-4 py-3.5" style={{ background: "var(--raise)" }}>
                {[0, 150, 300].map((d) => (
                  <span
                    key={d}
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--text-faint)]"
                    style={{ animationDelay: `${d}ms` }}
                  />
                ))}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* Suggestions */}
        {items.length <= 1 && (
          <div className="flex flex-wrap gap-2 border-t border-[var(--border)] px-5 py-3">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                disabled={busy}
                className="btn-soft focus-ring rounded-full px-3.5 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
          className="flex items-center gap-3 border-t border-[var(--border)] p-4"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about your pipeline, leads, meetings…"
            className="flex-1 rounded-xl border border-[var(--border)] bg-transparent px-4 py-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-[var(--border-strong)]"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="btn-accent focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-xl disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="h-[18px] w-[18px]" />
          </button>
        </form>
      </Card>
    </div>
  );
}
