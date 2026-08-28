"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Send, Sparkles } from "lucide-react";
import { instantToWallClock } from "@/lib/zoned";
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
 * "12 March 2026" from a `YYYY-MM-DD` key, for the day separator.
 *
 * Built from the parts rather than `new Date(key)` and a locale format: the
 * key is already wall-clock in the business's zone, so re-parsing it as a date
 * would re-apply an offset and can land the pill on the wrong day either side
 * of midnight. Splitting the string cannot drift.
 */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function dayLabel(key: string): string {
  const [year, month, day] = key.split("-");
  const name = MONTHS[Number(month) - 1];
  if (!name) return key;
  return `${Number(day)} ${name} ${year}`;
}

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
  timeZone,
}: {
  messages: ChatMessage[];
  aiEnabled: boolean;
  knows: Knows;
  /** The business's zone. See `page.tsx`: bubble times must not be formatted
      against the device, or the server and the client disagree. */
  timeZone: string;
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

  /*
     Pin the page to what is actually VISIBLE, and stop it scrolling.

     `100dvh` is the dynamic viewport, and on iOS that is a moving target: the
     Safari toolbar collapses as you scroll and expands as you scroll back, and
     the keyboard does not shrink `dvh` at all. Both leave the document taller
     than the part of it you can see, so the page scrolls — and what scrolls
     into view under the composer is empty background. That is the gap: not a
     margin, but the bottom of a document that is longer than the screen.

     `visualViewport.height` is the one number that always describes the region
     the user can actually see — toolbar collapsed or not, keyboard up or down.
     Writing it to a custom property lets the layout follow it exactly, so the
     composer sits on the bottom edge of the visible area at every moment
     instead of at the bottom of a document that extends past it.

     With nothing left to scroll, the toolbar stops collapsing too, which is
     what stops the height oscillating in the first place.

     Direct DOM writes rather than state: this runs on every frame of a toolbar
     transition, and re-rendering the whole conversation each time would be
     visible. It is also why there is no `setState` here for the React compiler
     to object to.
  */
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;

    const apply = () => {
      root.style.setProperty("--chat-vh", `${Math.round(viewport?.height ?? window.innerHeight)}px`);

      /*
         Put the page back where it belongs.

         Focusing the composer makes Safari pan the page up to reveal it, and
         because the document has nothing to scroll that pan is never undone —
         dismissing the keyboard left the contact bar off the top of the screen
         and the gap back underneath, permanently, until a reload. Verified on
         the simulator before and after.

         Zero is the only correct scroll position on a page that fills the
         screen, so it is simply asserted whenever the viewport moves. A no-op
         when nothing was panned.
      */
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };

    apply();
    root.classList.add("chat-open");
    viewport?.addEventListener("resize", apply);
    viewport?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);

    return () => {
      viewport?.removeEventListener("resize", apply);
      viewport?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      /* Both undone on the way out, or every other page inherits a locked
         body and a stale height. */
      root.classList.remove("chat-open");
      root.style.removeProperty("--chat-vh");
    };
  }, []);

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

  /*
     Whether the reader is past needing suggestions.

     Two things end it, and a seeded greeting is neither.

     TYPING: once there is a draft the reader has decided what to ask, and four
     tappable questions below the box are just something between them and their
     own sentence. On a phone they are also 191px of it.

     HAVING ASKED: a `role === "user"` message, not merely a message. `items`
     is seeded with an assistant greeting and `reset()` keeps it, so counting
     messages meant the suggestions never came back after New chat — the reader
     tapped it and landed on a greeting with nothing to tap and no empty state
     either, which is a worse first-run than the one they started with.
  */
  const engaged = draft.trim().length > 0 || items.some((m) => m.role === "user");

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
    <div className="mx-auto -mb-6 flex h-[calc(var(--chat-vh)-88px)] max-w-[900px] animate-fade-up flex-col sm:mb-0 sm:h-[calc(100dvh-112px)] lg:h-[calc(100vh-104px)]">
      {/*
          A contact bar, the way a messaging app does it.

          It was a hero card: a bordered, tinted panel with a title, a status
          pill and a sentence, 178px tall on a 575px screen against a
          conversation of 40. A chat app does not put a poster above the
          conversation — it puts a thin bar with who you are talking to, their
          status, and the actions, and gives every remaining pixel to the
          messages. That is most of why the reference feels effortless: there is
          almost nothing between the reader and the thread.

          So: one row, avatar and name and a live status line, a hairline under
          it, and no panel. The status line replaces the badge — "Answering from
          your live CRM data" says what DATA MODE said, in the place and voice a
          messaging app says "online".
      */}
      <div className="mb-1 flex items-center gap-3 border-b border-[var(--border)] px-1 pb-3 sm:gap-3.5">
        <span className="chat-orb shrink-0">
          <Sparkles className="h-[22px] w-[22px]" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <h1 className="truncate text-base font-semibold tracking-tight">CRM Assistant</h1>
          {/*
              Where "online" goes in the reference, and it does the same job the
              badge used to: says whether the answers are live. It reads as a
              status rather than a label because that is what it is, and the dot
              carries the same colour the pill did — green when the model is
              connected, amber when it is answering from data alone.

              The counts are gone. They were never a fact anybody acted on, and
              a contact bar states who you are talking to, not an inventory.
          */}
          <p className="flex items-center gap-1.5 truncate text-xs text-muted">
            <span
              className="chat-live-dot"
              style={{ color: aiEnabled ? "var(--green)" : "var(--amber)" }}
            />
            {aiEnabled ? "Online" : "Answering from your data"}
            {/*
                The receipts, where there is room for them.

                The counts were the page's evidence for the claim that it
                answers from real records, and dropping them entirely would take
                the honesty with the clutter. On a desktop they fit on the
                status line, which is exactly where a messaging app puts "last
                seen" — a fact about the other party, stated once. On a phone
                the line stays short.
            */}
            <span className="hidden truncate sm:inline">
              · {knows.contacts} contacts, {knows.deals} deals, {knows.meetings} meetings
            </span>
          </p>
        </div>
        {/* The reference puts video and voice here; ours has one action, and it
            is the same one it always was. */}
        <button
          onClick={reset}
          disabled={busy}
          aria-label="New chat"
          title="New chat"
          className="btn-soft focus-ring grid h-10 w-10 shrink-0 place-items-center rounded-full disabled:opacity-50"
        >
          <RotateCcw className="h-[18px] w-[18px]" />
        </button>
      </div>

      {/*
          The conversation is the page, not a panel on it.

          It was wrapped in a `Card`: a bordered, translucent box with the
          messages inside it, so a bubble sat on a panel that sat on the page —
          three surfaces deep, with a frame drawn around the one thing the
          screen is for. No messaging app does that, and it is the other half of
          why the reference reads as effortless: the thread runs edge to edge and
          the only shapes are the bubbles.

          So the frame goes and the messages sit on the page background
          directly. The composer keeps a hairline above it, which is the one
          rule the reference does draw.
      */}
      <div className="flex min-h-0 flex-1 flex-col">
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
        {/* `space-y` is gone: runs set their own spacing, 2.5 between turns and
            0.5 within one, the way the reference tucks a burst together. A flat
            16px gutter made every message its own island. */}
        <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-1">
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
              {/*
                  The paragraph is desktop-only, because on a phone it does not
                  fit and does not earn the space.

                  Measured at 320x575: with the suggestions showing, the
                  transcript gets 126px and this empty state needs 182 — so the
                  orb and the heading were scrolled off the top and the reader
                  arrived at a paragraph cut mid-sentence. That is the reported
                  screenshot.

                  It is also the most redundant text on the page. It ends "Pick a
                  question below, or type your own", and the questions are
                  directly below and the composer directly under those. The
                  chips ARE this instruction, spelled out and tappable.

                  What is left on a phone is an orb, "Ask about your pipeline",
                  and four real questions — which is the whole idea, and fits.
              */}
              <p className="mt-2 hidden max-w-[34ch] text-sm leading-relaxed text-muted sm:block">
                Answers come from your own contacts, deals and meetings — nothing is
                estimated. Pick a question below, or type your own.
              </p>
            </div>
          )}

          {/*
              The day pill, centred, the way the reference stamps a thread.

              Only where the day actually changes — a separator that repeats on
              every message is decoration, and one that never appears leaves a
              long thread with no anchor in time at all.
          */}
          {items.map((m, i) => {
            const mine = m.role === "user";
            const day = instantToWallClock(m.at, timeZone)?.date;
            const previousDay = i > 0 ? instantToWallClock(items[i - 1].at, timeZone)?.date : null;
            const newDay = !!day && day !== previousDay;
            /* A run is consecutive messages from the same side. The reference
               tucks them together and only tails the last one, which is what
               makes a burst read as one turn rather than three objects. */
            const startsRun = i === 0 || items[i - 1].role !== m.role;
            const endsRun = i === items.length - 1 || items[i + 1].role !== m.role;
            const clock = instantToWallClock(m.at, timeZone);

            return (
              <div key={m.id}>
                {newDay && (
                  <div className="flex justify-center py-3">
                    <span
                      className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-muted"
                      style={{ background: "var(--raise)" }}
                    >
                      {dayLabel(day!)}
                    </span>
                  </div>
                )}
                <div
                  className={clsx(
                    "flex",
                    mine ? "justify-end" : "justify-start",
                    newDay ? "" : startsRun ? "mt-2.5" : "mt-0.5"
                  )}
                >
                {/*
                    No avatar beside every message.

                    The reference shows one in a group chat and none in a
                    one-to-one, because in a two-party thread the side of the
                    screen already says who spoke — an icon on every line is
                    repeating what the alignment states, and it costs 42px of
                    the bubble's width on a 320px screen.
                */}
                <div
                  className={clsx(
                    "relative max-w-[78%] rounded-2xl px-3 py-2 text-sm leading-relaxed",
                    mine ? "text-white" : "text-[var(--text)]",
                    /* The tail. A real WhatsApp bubble grows a pointed flick on
                       the outer corner of the last message in a run; squaring
                       that one corner reads as the same thing and survives a
                       gradient fill, which a clipped pseudo-element does not. */
                    endsRun && (mine ? "rounded-br-md" : "rounded-bl-md")
                  )}
                  style={
                    mine
                      ? { backgroundImage: "linear-gradient(135deg,var(--accent-from),var(--accent-to))" }
                      : { background: "var(--raise)" }
                  }
                >
                  {/*
                      The time sits INSIDE the bubble, on the last line, right.

                      That is the detail that makes the reference dense without
                      feeling cramped: no separate metadata row, no gap between
                      messages spent on a timestamp. A float does it — a short
                      message keeps the time beside it on the same line, and a
                      long one wraps around it.

                      It has to come AFTER the text. A float attaches to the
                      line box it is encountered on, so placed first it sat at
                      the TOP right of a multi-line bubble with the text flowing
                      under it — which is not where anyone looks for it.
                  */}
                  <span className="whitespace-pre-wrap">{renderText(m.text)}</span>
                  <span
                    className={clsx(
                      "pointer-events-none float-right ml-2 mt-1.5 select-none text-[10px] leading-none",
                      mine ? "text-white/70" : "text-faint"
                    )}
                  >
                    {clock?.time}
                  </span>
                  </div>
                </div>
              </div>
            );
          })}

          {busy && (
            <div className="mt-2.5 flex justify-start">
              <div
                className="flex items-center gap-1.5 rounded-2xl rounded-bl-md px-4 py-3"
                style={{ background: "var(--raise)" }}
              >
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
          data-engaged={engaged ? "true" : undefined}
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
          className="flex shrink-0 items-end gap-2 border-t border-[var(--border)] px-2 py-2.5"
        >
          {/*
              A pill and a round button, which is what the reference uses and
              what every messaging app has converged on: the field looks like
              something you speak into rather than a form control, and the send
              key is a target your thumb finds without looking.

              `rounded-full` and `!rounded-full` — `.field-input` sets its own
              radius from globals.css, which is unlayered and therefore beats
              the utility. Same trap as `.chat-chips`; important is the way
              past it that does not mean editing the shared input style for
              every other form in the app.
          */}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            /* Short on a phone: the full prompt renders as "Ask about your
               pipeline, leads, meeti" in a 393px field, and a placeholder that
               gets cut mid-word looks like a bug rather than a hint. */
            placeholder={narrow ? "Ask anything…" : "Ask about your pipeline, leads, meetings…"}
            className="field-input flex-1 !rounded-full px-4"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="btn-accent focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-full transition-opacity disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="h-[18px] w-[18px]" />
          </button>
        </form>
      </div>
    </div>
  );
}
