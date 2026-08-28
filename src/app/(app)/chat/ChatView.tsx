"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Send, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/Card";
import type { ChatMessage } from "@/server/repos/chat";
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

/**
 * Whether the viewport is narrow enough to need the short placeholder.
 *
 * A placeholder is an attribute, not an element, so CSS cannot shorten it — it
 * has to be chosen in JS. Defaults to false so the server and the first client
 * render agree; the effect corrects it immediately after mount, which is
 * invisible for a hint string.
 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 639.98px)");
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return narrow;
}

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
  const narrow = useNarrow();
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  /*
     Scroll the TRANSCRIPT, not the page.

     `endRef.current.scrollIntoView()` walks up to the nearest scrollable
     ancestor and moves whatever it finds — and when the iOS keyboard opens, the
     visual viewport shrinks while `dvh` does not, so the document itself
     becomes scrollable. Every reply then dragged the whole page up and took the
     header off the top of the screen with it. That is the jump in the report:
     not the messages moving, but the app moving around them.

     Setting `scrollTop` on the log addresses one element and cannot touch
     anything else, so the header stays where it is and only the conversation
     moves.
  */
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
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
    /*
       A chat has to own the screen it is on.

       This was `h-auto` below `lg`, so on every phone and tablet the container
       took its height from its contents — and since the conversation area is
       `flex-1`, it had nothing to fill and collapsed. Measured on a 852px
       viewport: the panel came out 326px tall with a FORTY PIXEL message area,
       leaving two thirds of the screen empty below it. That is the whole of the
       "squished" complaint; the parts were all correct, they just had no room.

       `dvh`, not `vh`, and that matters on exactly the device this is for:
       Safari's toolbar collapses as you scroll, so `100vh` is the TALLEST the
       viewport ever gets and a `100vh` panel is permanently taller than the
       screen — the composer ends up under the toolbar, which is the worst place
       to put the one control the page exists for. `dvh` tracks the real height.

       112px is the chrome above and below it: an 80px header plus main's 32px
       of bottom padding, both measured rather than guessed. The `lg` value is
       untouched.
    */
    /*
       On a phone the composer sits at the bottom of the screen, not 33px above
       it.

       `main` ends in 32px of bottom padding, which is right for a page you
       scroll and wrong for one that fills the screen: it left a band of empty
       background under the composer while the conversation above it was
       starved. `-mb-6` gives 24 of those pixels back and `88px` — the 80px
       header plus an 8px breath — replaces the 112 that assumed the padding was
       still there. Eight is enough to keep the card off the very edge without
       reading as a gap.

       Both are reversed from `sm` up, where the page keeps its footer margin and
       the height it always had.
    */
    <div className="mx-auto -mb-6 flex h-[calc(100dvh-88px)] max-w-[900px] animate-fade-up flex-col sm:mb-0 sm:h-[calc(100dvh-112px)] lg:h-[calc(100vh-104px)]">
      {/*
          Identity — and on a phone it has to earn its height.

          Measured at 320x575 it was 178px: 31% of the whole viewport, for a
          title, a status pill and a sentence. The conversation below it got 40.
          Nothing here is wrong on a desktop, where 178px of a 900px screen is
          nothing; it is the phone where a fixed-height page has to spend its
          pixels on the part the user came for.

          Three things give it back, all `max-sm:` and all reversed at `sm`:
          tighter padding, a smaller orb, and — the big one — the reset button
          stops wrapping onto a line of its own by becoming an icon.
      */}
      <div className="chat-hero mb-3 flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:mb-4 sm:gap-4 sm:px-5 sm:py-4">
        {/* `flex-1` so it shrinks instead of pushing the button onto its own
            row — the 56px that wrapping used to cost. */}
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-3.5">
          <span className="chat-orb">
            <Sparkles className="h-[22px] w-[22px]" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-bold tracking-tight sm:text-[19px]">CRM Assistant</h1>
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
            {/*
                The same claim, in one line instead of three.

                Below `sm` the prose wrapped to three lines at 320px — most of
                the hero's height for a sentence whose actual content is three
                numbers. The counts are the claim; "Answering from" and "live"
                are the framing, and the badge beside the title already says the
                page is live. So the phone gets the numbers, separated rather
                than narrated, on one line that truncates only in the impossible
                case.

                Both are rendered and one is displayed, so there is no
                client-only string and nothing to mismatch on hydration.
            */}
            {/*
                No counts line on a phone.

                It was asked whether something more useful could go here, and the
                honest answer is no. Anything genuinely actionable — what is due,
                who is waiting — is the Home page's job, and repeating it here
                would be the duplication this app keeps having to remove. The
                counts themselves are not a fact anybody acts on; the badge
                beside the title already carries the only thing that changes what
                you do, which is whether answers are live.

                So the room goes to the conversation instead: two wrapped lines
                on a 575px screen, plus the margin above them, is 32px that the
                transcript can use.

                The desktop keeps it. There it is one line in a wide strip, it
                costs nothing, and it is the page stating on its face that the
                answers are grounded in real records rather than invented.
            */}
            <p className="mt-1.5 hidden text-xs text-muted sm:block sm:truncate">
              Answering from{" "}
              <strong className="font-semibold text-[var(--text)]">{knows.contacts}</strong> contacts,{" "}
              <strong className="font-semibold text-[var(--text)]">{knows.deals}</strong> deals and{" "}
              <strong className="font-semibold text-[var(--text)]">{knows.meetings}</strong> meetings — live.
            </p>
          </div>
        </div>
        {/* Icon-only on a phone. With the label it was wider than the room left
            beside the title, so it wrapped to a row of its own and took 56px
            with it — the single biggest line item in the hero. The action is
            unchanged and still labelled for screen readers. */}
        <button
          onClick={reset}
          disabled={busy}
          aria-label="New chat"
          title="New chat"
          className="btn-soft focus-ring flex shrink-0 items-center gap-2 rounded-xl p-2.5 text-sm font-medium disabled:opacity-50 sm:px-3.5 sm:py-2"
        >
          <RotateCcw className="h-4 w-4" /> <span className="hidden sm:inline">New chat</span>
        </button>
      </div>

      {/* Conversation */}
      <Card className="flex min-h-0 flex-1 flex-col !p-0">
        {/*
            `min-h-0` is what keeps the composer on the screen.

            A flex item's automatic minimum size is its CONTENT height, so
            without this the transcript refused to shrink below what it held and
            pushed the composer out of the bottom of the card instead. Measured
            at 320x575: the card ended at 543 while the composer ran 506 to 585
            — hanging 42px below the card and off the viewport entirely, which
            is the overlap in the report.

            With it, the transcript is the part that gives way. That is the
            right way round: it scrolls, and the composer does not.
        */}
        {/* `overscroll-contain`: reaching the top or bottom of the conversation
            stops there instead of handing the gesture on to the page behind it,
            which is what made a flick past the last message rubber-band the
            whole app. */}
        <div ref={logRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-5">
          {/*
              Something to look at before the first question.

              The conversation area is `flex-1`, so on an empty chat it was a
              blank panel taking most of the screen — the single biggest reason
              this page read as unfinished. A first-run state is not decoration
              here; it is the only thing standing between the user and a void.

              The copy claims nothing the page cannot back up. The header above
              already states exactly what it is answering from, and this repeats
              the promise the Reports page makes: the figures come from the
              user's own records rather than being estimated.
          */}
          {items.length === 0 && !busy && (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <span className="chat-orb mb-4">
                <Sparkles className="h-[22px] w-[22px]" />
              </span>
              <p className="text-base font-semibold">Ask about your pipeline</p>
              <p className="mt-2 max-w-[34ch] text-sm leading-relaxed text-muted">
                Answers come from your own contacts, deals and meetings — nothing is
                estimated. Pick a question below, or type your own.
              </p>
            </div>
          )}

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
            user types so a half-formed question is one click from an answer.

            On a phone they stand down once the conversation starts.

            They wrap full-width there, one question per line, which measured
            191px — on a 320x575 screen that is a third of the viewport and more
            than the whole card had left after the composer. It is why the
            transcript came out FORTY pixels tall and the messages were
            unreadable.

            Empty, they are the point of the screen and can have the room: there
            is nothing to read yet, and they are the fastest way in for someone
            who does not know what to ask. Once there are messages the transcript
            is what the page is for, and the composer is right there to type in.

            Not a horizontal scroller — that hides most of them off the right
            edge, which is the one thing this page must not do.

            Desktop keeps them throughout: `max-sm:` only, and there is room. */}
        <div
          /*
              A data attribute rather than `max-sm:hidden`, because the utility
              cannot win here. `.chat-chips` sets `display: flex` from
              globals.css, which is UNLAYERED, and unlayered CSS beats every
              Tailwind utility regardless of source order — measured: the class
              was applied and the chips still rendered. The rule that hides them
              has to live beside the rule that shows them.
          */
          data-conversation={items.length > 0 ? "true" : undefined}
          className="chat-chips shrink-0 border-t border-[var(--border)] px-5 py-3"
        >
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
          /* `shrink-0`: the composer is the one control this page exists for
             and must never be the thing that gives way. */
          className="flex shrink-0 items-center gap-3 border-t border-[var(--border)] p-4"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            /* Short on a phone: the full prompt renders as "Ask about your
               pipeline, leads, meeti" in a 393px field, and a placeholder that
               gets cut mid-word looks like a bug rather than a hint. */
            placeholder={narrow ? "Ask anything…" : "Ask about your pipeline, leads, meetings…"}
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
