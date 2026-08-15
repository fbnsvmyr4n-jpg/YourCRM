"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Send, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/Card";
import type { ChatMessage } from "@/server/chat-repo";
import { intentOf, suggestFor } from "@/server/chat-answers";
import { clsx } from "@/lib/clsx";
import { clearChatAction, sendChatAction } from "./actions";

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

type Knows = { contacts: number; deals: number; meetings: number };

export function ChatView({
  messages,
  aiEnabled,
  knows,
}: {
  messages: ChatMessage[];
  aiEnabled: boolean;
  knows: Knows;
}) {
  const [items, setItems] = useState(messages);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items, busy]);

  // What this conversation has already covered, so the idle strip suggests
  // something new rather than re-offering a question just answered.
  const asked = useMemo(
    () =>
      items
        .filter((m) => m.role === "user")
        .map((m) => intentOf(m.text))
        .filter((id): id is string => !!id),
    [items]
  );

  const suggestions = useMemo(() => suggestFor(draft, asked), [draft, asked]);

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
      {/* Identity */}
      <div className="chat-hero mb-4 flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="chat-orb">
            <Sparkles className="h-[22px] w-[22px]" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[19px] font-bold tracking-tight">CRM Assistant</h1>
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wide"
                style={
                  aiEnabled
                    ? { background: "var(--green-soft)", color: "var(--green)" }
                    : { background: "var(--amber-soft)", color: "var(--amber)" }
                }
              >
                <span className="chat-live-dot" />
                {aiEnabled ? "AI CONNECTED" : "DATA MODE"}
              </span>
            </div>
            <p className="mt-1.5 truncate text-xs text-muted">
              Answering from{" "}
              <strong className="font-semibold text-[var(--text)]">{knows.contacts}</strong> contacts,{" "}
              <strong className="font-semibold text-[var(--text)]">{knows.deals}</strong> deals and{" "}
              <strong className="font-semibold text-[var(--text)]">{knows.meetings}</strong> meetings — live.
            </p>
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
                <span className="chat-orb-sm mr-2.5 mt-0.5">
                  <Sparkles className="h-4 w-4" />
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
              <span className="chat-orb-sm mr-2.5 mt-0.5">
                <Sparkles className="h-4 w-4" />
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

        {/* Suggestions — kept for the whole conversation, and rewritten as the
            user types so a half-formed question is one click from an answer. */}
        <div className="chat-chips border-t border-[var(--border)] px-5 py-3">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => send(s)}
              disabled={busy}
              className="chat-chip focus-ring shrink-0"
            >
              {s}
            </button>
          ))}
        </div>

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
            className="field-input flex-1"
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
