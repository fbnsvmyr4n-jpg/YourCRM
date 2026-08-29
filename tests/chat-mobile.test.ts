import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The assistant page has to own the screen it is on.
 *
 * Reported as looking and functioning poorly, and squished. Measured on an
 * 852px viewport it was: the panel rendered 326px tall with a FORTY PIXEL
 * conversation area, two thirds of the screen empty below it, the suggestion
 * chips running off the right edge, and nothing at all inside the conversation
 * because an empty chat had no first-run state.
 */

const view = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/chat/ChatView.tsx", import.meta.url)),
  "utf8"
);
const css = readFileSync(
  fileURLToPath(new URL("../src/app/globals.css", import.meta.url)),
  "utf8"
);

describe("the assistant fills the phone screen", () => {
  it("has a real height below the desktop breakpoint", () => {
    /* It was `h-auto` until `lg`, so the conversation area — which is flex-1 —
       had nothing to fill and collapsed to nothing. */
    expect(view).not.toMatch(/className="mx-auto flex h-auto/);
    expect(view).toMatch(/h-\[calc\(100dvh-\d+px\)\]/);
  });

  it("measures that height in dvh, not vh", () => {
    /**
     * This is the one device where the distinction bites. Safari's toolbar
     * collapses as you scroll, so `100vh` is the TALLEST the viewport ever
     * gets — a `100vh` panel is permanently taller than the screen and pushes
     * the composer underneath the toolbar, which is the worst possible place
     * for the one control the page exists for.
     */
    const mobileHeight = view.match(/h-\[calc\(100(dvh|vh)-\d+px\)\]/);
    expect(mobileHeight?.[1]).toBe("dvh");
  });

  it("shows something before the first question", () => {
    /* The conversation is flex-1, so on an empty chat it was a blank panel
       taking most of the screen — the single biggest reason the page read as
       unfinished. */
    expect(view).toMatch(/items\.length === 0 && !busy/);
  });

});

describe("the suggestions stay on screen", () => {
  const block = css.slice(css.indexOf("@media (max-width: 639.98px)", css.indexOf(".chat-chips")));

  it("wraps rather than scrolling on a phone", () => {
    /* They were a scrolling row, so the second chip read "Who should I follow
       up w…" and the rest were off the edge. These are the fastest way into the
       assistant for someone who does not know what to ask. */
    expect(block).toMatch(/\.chat-chips\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(block).toMatch(/\.chat-chips\s*\{[^}]*overflow-x:\s*visible/);
  });

  it("leaves the desktop row scrolling as it was", () => {
    const base = css.slice(css.indexOf(".chat-chips {"), css.indexOf("}", css.indexOf(".chat-chips {")));
    expect(base).toMatch(/overflow-x:\s*auto/);
  });
});

/**
 * Reported from a phone: the messages were "barely visible", the suggestions
 * overlapped the composer, and the notifications panel showed only half its
 * text.
 *
 * Measured at 320x575 — a 393pt iPhone with Display Zoom on, which is what the
 * report came from:
 *
 *                before   after
 *   hero          178px    115px
 *   transcript     40px    256px
 *   suggestions   191px     hidden once the conversation starts
 *   composer      42px BELOW the card, and off the bottom of the screen
 *                          inside it
 */
describe("the conversation gets the room", () => {
  it("lets the transcript shrink so the composer cannot be pushed out", () => {
    /**
     * A flex item's automatic minimum size is its CONTENT height, so without
     * `min-h-0` the transcript refused to shrink and the composer was pushed
     * out of the bottom of the card — measured at 543 for the card against 585
     * for the composer, 42px past it and off the viewport.
     *
     * With it, the transcript is what gives way, which is the right way round:
     * it scrolls, the composer does not.
     */
    /* Anchored on the two tokens that carry the behaviour rather than the whole
       class string — the paint around them has changed twice already, and a
       test that breaks on a repaint while proving nothing about the layout is
       the kind you learn to ignore. */
    const log = view.slice(view.indexOf("ref={logRef}"));
    const cls = log.slice(log.indexOf('className="') + 11, log.indexOf('"', log.indexOf('className="') + 11));
    expect(cls.split(/\s+/)).toContain("min-h-0");
    expect(cls.split(/\s+/)).toContain("flex-1");
  });

  it("never lets the composer be the thing that shrinks", () => {
    /* Token-based, not the whole class string. This has now broken twice on
       changes to the PAINT while proving nothing about the layout — once when
       `overscroll-contain` was added, once when the composer became a pill.
       What matters is only that neither of these can be picked as the flex item
       that collapses. */
    const composerCls = (() => {
      const at = view.indexOf("onSubmit={(e) => {");
      const rest = view.slice(at);
      const i = rest.indexOf('className="') + 11;
      return rest.slice(i, rest.indexOf('"', i));
    })();
    expect(composerCls.split(/\s+/)).toContain("shrink-0");
    expect(view).toMatch(/className="chat-chips shrink-0\b/);
  });

  it("stands the suggestions down once the conversation starts", () => {
    /**
     * Wrapped full-width they measure 191px, which on a 320x575 screen is more
     * than the card had left after the composer — the transcript came out FORTY
     * pixels tall. Empty they keep the room, because there is nothing to read
     * yet and they are the fastest way in.
     *
     * A data attribute, not `max-sm:hidden`: `.chat-chips` sets `display: flex`
     * from globals.css, which is UNLAYERED and therefore beats every Tailwind
     * utility regardless of order. Measured — the utility was applied and the
     * chips still rendered. The rule that hides them has to live beside the
     * rule that shows them.
     */
    expect(view).toMatch(/data-engaged=\{engaged \? "true" : undefined\}/);
    const block = css.slice(css.indexOf("@media (max-width: 639.98px)", css.indexOf(".chat-chips")));
    expect(block).toMatch(/\.chat-chips\[data-engaged="true"\]\s*\{[^}]*display:\s*none/);
    /* And only there — on a desktop they stay for the whole conversation. */
    const base = css.slice(css.indexOf(".chat-chips {"), css.indexOf("}", css.indexOf(".chat-chips {")));
    expect(base).not.toMatch(/display:\s*none/);
  });

});

describe("the notifications panel", () => {
  const topbar = readFileSync(
    fileURLToPath(new URL("../src/components/shell/Topbar.tsx", import.meta.url)),
    "utf8"
  );

  it("is pinned to the screen on a phone, not to the bell", () => {
    /**
     * `absolute right-0` anchors the panel's right edge to the BELL, and the
     * bell is not at the right edge of the screen — the avatar sits after it.
     * Measured at 320: the bell's right edge is 260 and the panel is 294 wide,
     * so it started at -34 and the word "Notifications", every icon and the
     * start of every title were off the side with no way to reach them.
     *
     * Fixed with equal gutters instead: 12 to 308 at 320px wide. Verified that
     * no ancestor establishes a containing block for fixed positioning, so it
     * resolves against the viewport rather than the header.
     */
    expect(topbar).toMatch(/className="popover fixed left-3 right-3 top-\[72px\] z-30 overflow-hidden p-0 sm:absolute sm:left-auto sm:right-0 sm:top-12 sm:w-\[min\(92vw,380px\)\]"/);
  });

  it("gives the desktop panel back every value it had", () => {
    /* Measured at 1280 after the change: position absolute, 380px wide, right
       edge exactly on the bell's — the panel it always was. */
    const panel = topbar.slice(topbar.indexOf('className="popover'), topbar.indexOf('"', topbar.indexOf('className="popover') + 12));
    for (const restored of ["sm:absolute", "sm:left-auto", "sm:right-0", "sm:top-12", "sm:w-\\[min\\(92vw,380px\\)\\]"]) {
      expect(panel).toMatch(new RegExp(restored));
    }
  });
});

describe("the chat reaches the bottom of the phone", () => {
  it("does not leave a band of background under the composer", () => {
    /**
     * `main` ends in 32px of bottom padding — right for a page you scroll,
     * wrong for one that fills the screen. Measured at 320x575 it left 33px of
     * empty background below the composer while the conversation above it was
     * starved.
     *
     * `-mb-6` gives 24 of those back and the height drops to the 80px header
     * plus an 8px breath. Measured after: a 9px gap, and the page still does
     * not scroll.
     */
    /* The height now comes from `--chat-vh` rather than `dvh` — see "sizes the
       page from the visible viewport" below for why. What this assertion is
       about is the `-mb-6`: main's 32px footer padding is right for a page you
       scroll and wrong for one that fills the screen. */
    expect(view).toMatch(/-mb-6 flex h-\[calc\(var\(--chat-vh\)-88px\)\]/);
  });

  it("gives the desktop back its footer margin and its height", () => {
    /* Measured at 1280 after the change: shell 696px against a 800px viewport,
       which is the `100vh-104px` it always was, and margin-bottom 0. */
    expect(view).toMatch(/sm:mb-0 sm:h-\[calc\(100dvh-112px\)\] lg:h-\[calc\(100vh-104px\)\]/);
  });
});

describe("the page holds still", () => {
  it("scrolls the transcript rather than the document", () => {
    /**
     * The jump that made the page feel unsteady. `scrollIntoView` walks up to
     * the nearest scrollable ancestor and moves whatever it finds — and when
     * the iOS keyboard opens, the visual viewport shrinks while `dvh` does not,
     * so the DOCUMENT becomes scrollable. Every reply then dragged the whole
     * app up and took the header off the top of the screen, which is exactly
     * what the reported screenshot shows.
     *
     * Addressing the log element directly cannot touch anything else. Measured
     * after a reply: scrollY 0, header still at y=0, log pinned to its bottom.
     */
    expect(view).toMatch(/log\.scrollTo\(\{ top: log\.scrollHeight, behavior: "smooth" \}\)/);
    const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/scrollIntoView/);
  });

  it("stops a flick past the last message from dragging the app", () => {
    /* Without this, reaching either end of the conversation hands the gesture
       on to the page behind it and the whole thing rubber-bands. */
    const logCls = (() => {
      const rest = view.slice(view.indexOf("ref={logRef}"));
      const i = rest.indexOf('className="') + 11;
      return rest.slice(i, rest.indexOf('"', i));
    })();
    expect(logCls.split(/\s+/)).toContain("overscroll-contain");
  });
});


describe("the suggestions get out of the way", () => {
  it("stand down as soon as the composer has focus", () => {
    /**
     * Asked for as "once you are typing you should see the box and the
     * conversation, nothing else", and first built on the DRAFT — which is what
     * made the composer disappear and come back.
     *
     * Keyed on the draft, the chips toggled every time the box went empty and
     * non-empty. That is 191px of layout appearing and vanishing on single
     * keystrokes, and with the keyboard up — where the page is handed to Safari,
     * which pans on focus and not on reflow — it shoved the composer out of the
     * visible strip and back. Traced frame by frame in a screen recording: with
     * "What" typed the composer is on screen; a moment later, empty, the chips
     * are back and the composer is gone.
     *
     * Focus cannot flicker — one state change in, one out — and someone with
     * the keyboard open is writing, not browsing questions.
     *
     * Measured at 390px across blurred, focused, typing, prediction shown,
     * prediction gone and cleared: the composer's bottom edge is 692 in every
     * one of them.
     */
    expect(view).toMatch(/const engaged = focused \|\| draft\.trim\(\)\.length > 0 \|\| items\.some\(\(m\) => m\.role === "user"\)/);
    expect(view).toMatch(/onFocus=\{\(\) => setFocused\(true\)\}/);
    expect(view).toMatch(/onBlur=\{\(\) => setFocused\(false\)\}/);
  });

  it("comes back after New chat, because New chat actually clears", () => {
    /**
     * Reported: tapping New chat brought the user's own last question back on
     * screen with the suggestions still hidden behind it.
     *
     * `reset()` was doing `prev.slice(0, 1)` — keep the FIRST message. An
     * earlier version of this test justified that as preserving a seeded
     * greeting, and there is no such thing: `listChat` returns exactly what is
     * stored and `clearChat` is a DELETE with no reseed. So the first message
     * is whatever the user asked first, and New chat deleted every message on
     * the server while leaving that one on screen — which also kept `engaged`
     * true, because the thread still contained a user message.
     *
     * An empty list is the only one that matches the server after a clear.
     */
    expect(view).toMatch(/await clearChatAction\(\);[\s\S]{0,900}?setItems\(\[\]\)/);
    const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toMatch(/prev\.slice\(0, 1\)/);
    /* And the condition still keys off having ASKED, which is what ends a first
       run whatever else the list may hold later. */
    expect(view).toMatch(/items\.some\(\(m\) => m\.role === "user"\)/);
  });

  it("leaves the desktop alone on both counts", () => {
    /* Measured at 1280: suggestions still `flex` while typing, blurb still
       shown. The rule that hides them lives inside the phone media query. */
    const block = css.slice(css.indexOf("@media (max-width: 639.98px)", css.indexOf(".chat-chips")));
    expect(block).toMatch(/data-engaged/);
    const base = css.slice(css.indexOf(".chat-chips {"), css.indexOf("}", css.indexOf(".chat-chips {")));
    expect(base).not.toMatch(/display:\s*none/);
  });
});

describe("the first-run panel fits the phone", () => {
  it("drops the paragraph below sm", () => {
    /**
     * Reported as text cut off at the top of the panel, and the arithmetic
     * says why: with the suggestions showing the transcript gets 126px and this
     * empty state needed 182, so the orb and the heading scrolled off and the
     * reader arrived at a paragraph cut mid-sentence.
     *
     * It is also the most redundant text on the page — it ends "Pick a question
     * below, or type your own", and the questions are directly below it with
     * the composer under those. The chips are that instruction, tappable.
     *
     * What is left on a phone is the orb, the heading and four real questions.
     * Measured after: nothing clipped.
     */
    expect(view).toMatch(/className="mt-2 hidden max-w-\[34ch\] text-sm leading-relaxed text-muted sm:block"/);
  });

  it("keeps the heading, which is what the panel is for", () => {
    expect(view).toMatch(/<p className="text-base font-semibold">Ask about your pipeline<\/p>/);
  });
});

/**
 * The messaging-app layout.
 *
 * Asked for against a WhatsApp screenshot: the same look and feel, our colours.
 * What makes that reference effortless is not its palette — it is that almost
 * nothing sits between the reader and the thread.
 *
 * Ours had a bordered hero card above a bordered conversation card, so a bubble
 * sat on a panel that sat on the page: three surfaces deep, with a frame drawn
 * around the only thing the screen is for.
 */
describe("the conversation is the page", () => {
  const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("has no card frame around the thread", () => {
    expect(code).not.toMatch(/<Card/);
    expect(code).not.toMatch(/components\/ui\/Card/);
  });

  it("replaces the hero card with a contact bar", () => {
    /* One row: who you are talking to, their status, the action. No panel, no
       tint, no border box — a hairline under it and nothing else. */
    expect(code).not.toMatch(/chat-hero/);
    expect(view).toMatch(/border-b border-\[var\(--border\)\] px-1 pb-3/);
    /* The status line takes the badge's job and its colour, so live still reads
       green and data-only still reads amber. */
    expect(view).toMatch(/aiEnabled \? "var\(--green\)" : "var\(--amber\)"/);
    expect(view).toMatch(/aiEnabled \? "Online" : "Answering from your data"/);
  });

  it("keeps the receipts, on the desktop status line", () => {
    /**
     * The counts were the page's evidence for claiming it answers from real
     * records; dropping them with the hero would have taken the honesty along
     * with the clutter. They now sit where a messaging app puts "last seen",
     * and only where there is room for them.
     */
    expect(view).toMatch(/hidden truncate sm:inline/);
    expect(view).toMatch(/\{knows\.contacts\} contacts, \{knows\.deals\} deals, \{knows\.meetings\} meetings/);
  });
});

describe("the bubbles", () => {
  it("carry their own time, inside, on the last line", () => {
    /**
     * The detail that makes the reference dense without feeling cramped: no
     * separate metadata row, no gap between messages spent on a timestamp.
     *
     * The float must come AFTER the text. A float attaches to the line box it
     * is encountered on, so placed first it sat at the TOP right of a
     * multi-line bubble with the text flowing beneath it. Measured after the
     * swap: 15px from the bubble's bottom against 37 from its top.
     */
    const bubble = view.slice(view.indexOf("const mine = m.role"));
    const textAt = bubble.indexOf("renderText(m.text)");
    const timeAt = bubble.indexOf("{clock?.time}");
    /* Both must EXIST before their order means anything. Written as a bare
       `toBeGreaterThan`, deleting the message text passed the assertion: -1 is
       less than any real index, so the test proved nothing about a bubble with
       no text in it. Caught by mutation. */
    expect(textAt).toBeGreaterThanOrEqual(0);
    expect(timeAt).toBeGreaterThanOrEqual(0);
    expect(timeAt).toBeGreaterThan(textAt);
    expect(view).toMatch(/float-right ml-2 mt-1\.5/);
  });

  it("reads the time in the business's zone, not the device's", () => {
    /* Formatting against the browser renders one string on the server and
       another after hydration. `instantToWallClock` is deterministic given a
       zone, so both agree. */
    /* Both call sites, named. Asserted loosely as just
       `instantToWallClock(m.at, timeZone)`, hardcoding a zone on the CLOCK line
       still passed — the regex was satisfied by the DAY line, which reads
       identically. Caught by mutation. */
    expect(view).toMatch(/const clock = instantToWallClock\(m\.at, timeZone\)/);
    expect(view).toMatch(/const day = instantToWallClock\(m\.at, timeZone\)/);
    expect(view).toMatch(/timeZone: string/);
  });

  it("tucks a run together and tails only its last message", () => {
    /* Consecutive messages from one side are one turn, not three objects. */
    expect(view).toMatch(/const startsRun = i === 0 \|\| items\[i - 1\]\.role !== m\.role/);
    expect(view).toMatch(/const endsRun = i === items\.length - 1 \|\| items\[i \+ 1\]\.role !== m\.role/);
    expect(view).toMatch(/endsRun && \(mine \? "rounded-br-md" : "rounded-bl-md"\)/);
    expect(view).toMatch(/startsRun \? "mt-2\.5" : "mt-0\.5"/);
  });

  it("drops the avatar beside every message", () => {
    /* The reference shows one in a group chat and none in a one-to-one: the
       side of the screen already says who spoke, and the icon cost 42px of
       bubble width on a 320px screen. */
    const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toMatch(/chat-orb-sm/);
  });

  it("stamps the day only where it changes", () => {
    /* A separator on every message is decoration; one that never appears leaves
       a long thread with no anchor in time. */
    expect(view).toMatch(/const newDay = !!day && day !== previousDay/);
    expect(view).toMatch(/dayLabel\(day!\)/);
  });

  it("builds the day label from the key rather than re-parsing it", () => {
    /**
     * The key is already wall-clock in the business's zone. `new Date(key)`
     * would re-apply an offset and can land the pill on the wrong day either
     * side of midnight; splitting the string cannot drift.
     */
    const label = view.slice(view.indexOf("function dayLabel"), view.indexOf("function dayLabel") + 320);
    expect(label).toMatch(/key\.split\("-"\)/);
    expect(label).not.toMatch(/new Date/);
  });
});

/**
 * The gap under the composer.
 *
 * Reported as a band of empty background that appears when the page is
 * scrolled and is absent when it is not — "unprofessional and unfinished", and
 * it is: what scrolls into view down there is the bottom of a document longer
 * than the screen.
 *
 * `100dvh` is why. On iOS it is a moving target — Safari collapses its toolbar
 * as you scroll and expands it as you scroll back, and the keyboard does not
 * shrink `dvh` at all — so the layout was sized against a height that did not
 * match the region the user could actually see.
 */
describe("the composer holds the bottom edge", () => {
  it("sizes the page from the visible viewport, not dvh", () => {
    /**
     * `visualViewport.height` is the one number that always describes what the
     * user can see: toolbar collapsed or not, keyboard up or down. Measured at
     * 320x575 after the change: --chat-vh 575px, main scrollable by 0, an 8px
     * gap under the composer that does not move.
     */
    expect(view).toMatch(/setProperty\(\s*"--chat-vh",\s*`\$\{Math\.round\(window\.visualViewport\?\.height \?\? window\.innerHeight\)\}px`\s*\)/);
    expect(view).toMatch(/h-\[calc\(var\(--chat-vh\)-88px\)\]/);
    /* And a sane value before JS runs, so the first paint is not a calc()
       against an undefined variable. */
    expect(css).toMatch(/:root\s*\{[^}]*--chat-vh:\s*100dvh/);
  });

  it("follows the viewport while it is moving, not just once", () => {
    /* A toolbar collapse is a continuous transition and the keyboard is an
       animation; reading the height once on mount would pin the layout to
       whatever the viewport happened to be at that instant. */
    expect(view).toMatch(/viewport\?\.addEventListener\("resize", applyHeight\)/);
    expect(view).toMatch(/viewport\?\.addEventListener\("scroll", applyHeight\)/);
  });

  it("writes the height straight to the DOM rather than through state", () => {
    /* This fires on every frame of a toolbar transition. Re-rendering the whole
       conversation that often would be visible — and a `setState` in an effect
       is what the React compiler rejects. */
    const effect = view.slice(view.indexOf("const root = document.documentElement;"));
    expect(effect.slice(0, 900)).not.toMatch(/setState|useState/);
  });

  it("leaves nothing behind on the next page", () => {
    /**
     * The risk of locking a global. Without the teardown every other page in
     * the app inherits a frozen body and a stale height — a bug far worse than
     * the gap this fixes, and one that would only show up two navigations
     * later. Verified live: after routing to /deals the class is gone, the
     * inline property is cleared and overflow is back to normal.
     */
    expect(view).toMatch(/root\.classList\.remove\("chat-open"\)/);
    expect(view).toMatch(/root\.style\.removeProperty\("--chat-vh"\)/);
    expect(view).toMatch(/window\.removeEventListener\("resize", applyHeight\)/);
    expect(view).toMatch(/viewport\?\.removeEventListener\("resize", applyHeight\)/);
    expect(view).toMatch(/viewport\?\.removeEventListener\("scroll", applyHeight\)/);
  });

  it("stops the rubber-band going looking for the gap", () => {
    /* With the layout pinned there is nothing below the composer to reveal, but
       iOS will still pan a page that cannot scroll. Phone only: on a desktop
       this page has never scrolled and the shell expects the document to
       behave normally. */
    const block = css.slice(css.indexOf("html.chat-open"));
    expect(block).toMatch(/overflow:\s*hidden/);
    expect(block).toMatch(/overscroll-behavior:\s*none/);
    const guarded = css.slice(0, css.indexOf("html.chat-open"));
    expect(guarded.lastIndexOf("@media (max-width: 639.98px)")).toBeGreaterThan(
      guarded.lastIndexOf("@media (min-width")
    );
  });
});

/**
 * Predictive text, once the suggestions have stood down.
 *
 * They vanish on the first keystroke, which is right — four questions between
 * someone and their own sentence is clutter. But it left the reader thumbing a
 * whole question with no help, while `suggestFor` was already ranking the pool
 * against the draft on every keystroke and throwing the answer away.
 */
describe("the prediction bar", () => {
  it("offers the best match for what is being typed", () => {
    /* Verified live at 320px: typing "how many le" predicts "How many leads do
       I have?" in a single row above the composer. */
    expect(view).toMatch(/const prediction =/);
    expect(view).toMatch(/suggestions\[0\]/);
  });

  it("stays quiet when it has nothing to add", () => {
    /**
     * Two ways it would be noise rather than help: offered before there is
     * anything to predict from, and offered when it merely repeats what has
     * already been typed in full.
     */
    expect(view).toMatch(/draft\.trim\(\)\.length >= 2/);
    expect(view).toMatch(/suggestions\[0\]\.toLowerCase\(\) !== draft\.trim\(\)\.toLowerCase\(\)/);
  });

  it("completes the sentence rather than sending it", () => {
    /**
     * The reader is mid-sentence and may have meant something adjacent.
     * Completing their typing and leaving the send to them is the difference
     * between a shortcut and a hijack — and it is still one tap instead of a
     * whole question thumbed in.
     *
     * Verified live: tapping it set the draft, kept focus in the composer, and
     * sent nothing.
     */
    const bar = view.slice(view.indexOf("{prediction && ("));
    expect(bar.slice(0, 600)).toMatch(/setDraft\(prediction\)/);
    expect(bar.slice(0, 600)).not.toMatch(/send\(/);
    /* Focus goes straight back, or accepting it closes the keyboard. */
    expect(bar.slice(0, 600)).toMatch(/inputRef\.current\?\.focus\(\)/);
  });

  it("is a phone control only", () => {
    /* The desktop suggestion row never went away and already re-ranks on every
       keystroke; this would be the same question offered twice. Verified at
       1280: the bar is not displayed and the chips still are. */
    const bar = view.slice(view.indexOf("{prediction && ("));
    expect(bar.slice(0, 700)).toMatch(/sm:hidden/);
  });
});

describe("nothing moves the composer while typing", () => {
  it("floats the prediction instead of stacking it", () => {
    /**
     * The smaller cousin of the chip flicker. In the flow, the prediction row
     * pushed the composer down 34px as it appeared and pulled it back up as it
     * went — on the same keystroke that produced it. With the keyboard up that
     * is the composer sliding under the edge of the visible strip and back,
     * once per word.
     *
     * Out of the flow, it cannot move anything. Measured at 390px: composer
     * bottom 692 with the prediction showing and 692 without.
     */
    expect(view).toMatch(/absolute bottom-full left-0 right-0/);
    /* Opaque, because it now sits OVER the end of the conversation rather than
       above it. */
    expect(view).toMatch(/bg-\[var\(--panel-solid\)\]/);
    /* And it needs a positioned parent to hang from. */
    expect(view).toMatch(/<div className="relative shrink-0">/);
  });

  it("leaves the desktop suggestion row alone", () => {
    /* Measured at 1280 with the composer focused: the chips are still shown and
       the prediction is not. Focus is a phone concern — there is no keyboard
       taking half the screen. */
    const block = css.slice(css.indexOf("@media (max-width: 639.98px)", css.indexOf(".chat-chips")));
    expect(block).toMatch(/data-engaged/);
    expect(view).toMatch(/absolute bottom-full[^"]*sm:hidden/);
  });
});

/**
 * Typing owns the screen.
 *
 * From the screen recording: with the keyboard up, the visible strip is about
 * 250px. The app header was taking 80 of it and the chat's own contact bar
 * another 56, leaving the conversation roughly forty pixels — a sliver of one
 * bubble above the box, and at some moments nothing at all.
 *
 * Reading what you just asked while you type the next thing is the whole job of
 * a chat screen, and it was the part being squeezed out.
 *
 *   at 250px visible      before   after
 *   app header              80px       0
 *   contact bar             56px       0
 *   transcript              38px    175px
 *   composer on screen        no     yes
 */
describe("New chat means new", () => {
  it("clears the half-typed question as well as the messages", () => {
    /**
     * Reported: with text still in the box, New chat cleared the conversation
     * and the suggestions stayed hidden — the draft kept `engaged` true, so the
     * reader was left looking at their own abandoned sentence over an empty
     * screen, and had to delete it by hand before the page resembled a fresh
     * chat.
     *
     * Measured after: draft empty, messages 0, suggestions back at their full
     * 191px.
     */
    expect(view).toMatch(/setItems\(\[\]\);[\s\S]{0,900}?setDraft\(""\)/);
  });

  it("puts the keyboard away and says so outright", () => {
    /**
     * There is nothing left to type into, and dropping focus also brings the
     * app chrome back, so the reset lands on exactly the screen a first visit
     * shows.
     *
     * `setFocused(false)` as well as `blur()`, because `blur()` only fires
     * `onBlur` if the element really held focus — and a reset that half-works,
     * messages gone but suggestions still hidden, is the very state this is
     * here to prevent.
     */
    /* Scoped to `reset`. Matched against the whole file, deleting this line
       still passed — the regex was satisfied by the composer's own
       `onBlur={() => setFocused(false)}`, which is a different thing entirely.
       Caught by mutation. */
    const at = view.indexOf("async function reset()");
    /* To the end of the function, not a guessed number of characters — the
       first attempt used 1400 and the body is 1807, so the assertion was
       reading a window that stopped short of the line it was checking. */
    const reset = view.slice(at, view.indexOf("\n  }", at));
    expect(reset).toMatch(/inputRef\.current\?\.blur\(\)/);
    expect(reset).toMatch(/setFocused\(false\)/);
  });
});

/**
 * The composer does not move while you type.
 *
 * Reported from a recording of the installed app: tapping the box blanked the
 * screen — background only, with the text caret visible alone in it — until a
 * word was typed, at which point everything reappeared.
 *
 * Opening the keyboard is two things at once: the viewport shrinks over the
 * length of an animation, and WebKit pans the page to bring the focused field
 * into view. We were resizing on every frame of that shrink, so the composer
 * kept moving UP the document while WebKit was still travelling towards where
 * it had been. The pan landed on empty background.
 *
 *   700px -> 364px while focused    --chat-vh   composer
 *   before the fix                  followed    moved
 *   after                           700px       629-696, unchanged
 */
describe("the layout freezes while the composer has the caret", () => {
  it("stops following the viewport while focused", () => {
    /* The whole fix, in one guard. Measured across idle, focused, and a
       336px keyboard-sized shrink: `--chat-vh` stays 700px and the composer
       stays at 629-696 in all three. */
    expect(view).toMatch(/if \(focusedRef\.current\) return;/);
  });

  it("reads focus from a ref, not from the closure", () => {
    /**
     * The listeners are bound once. Reading `focused` directly would capture
     * the value at bind time and freeze the closure instead of the layout —
     * which is the opposite of the intent and would look identical until
     * someone typed.
     */
    expect(view).toMatch(/const focusedRef = useRef\(false\)/);
    expect(view).toMatch(/focusedRef\.current = focused/);
  });

  it("catches up the moment the freeze lifts", () => {
    /**
     * Without this a viewport change that happened while the caret was in the
     * box would be ignored for good: the listener declines to act while frozen,
     * and after blur nothing fires again to reconsider. Measured: blurred at
     * 364px, `--chat-vh` goes from a frozen 700 to 364.
     *
     * On a phone the closing keyboard does produce a resize, so it would
     * correct itself — but only by luck, and losing focus any other way would
     * leave the page sized for a keyboard that is no longer there.
     */
    expect(view).toMatch(/if \(!focused\) applyHeight\(\);/);
  });

  it("tears the lock down only on unmount", () => {
    /**
     * The catch-up is its own effect precisely so this one can keep empty deps.
     * Folded together, every focus change would run the cleanup and strip
     * `--chat-vh` and the scroll lock mid-interaction — a flash of unstyled
     * layout on every tap into the box.
     */
    const setup = view.slice(view.indexOf("const viewport = window.visualViewport;"));
    expect(setup).toMatch(/\}, \[applyHeight\]\);/);
    expect(setup).toMatch(/root\.classList\.remove\("chat-open"\)/);
  });

  it("no longer hides the app chrome to make room", () => {
    /**
     * That was the previous attempt, and it was one more thing moving at the
     * worst possible moment. Freezing buys the same room without moving
     * anything: WebKit's pan carries the header off the top by itself, which is
     * what the reference looks like anyway.
     */
    const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toMatch(/chat-typing/);
    expect(css).not.toMatch(/chat-typing/);
    expect(code).not.toMatch(/MIN_TRANSCRIPT|APP_HEADER|CONTACT_BAR/);
  });
});
