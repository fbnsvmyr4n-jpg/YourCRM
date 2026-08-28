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

  it("keeps the claim about where answers come from intact", () => {
    /* "Answering from 0 deals and 0 m…" cuts off exactly the part that makes
       the claim. The desktop line still only truncates from `sm`; the phone now
       gets its own shorter line, which wraps rather than truncating for the
       same reason. Both are rendered and one is displayed, so there is no
       client-only string to mismatch on hydration. */
    expect(view).toMatch(/text-xs text-muted sm:block sm:truncate/);
    /* And on a phone there is no counts line at all now — see "drops the counts
       line on a phone" below. The desktop claim is the one that survives. */
    const code = view.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/sm:hidden">\s*<strong/);
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
    expect(view).toMatch(/className="flex shrink-0 items-center gap-3 border-t/);
    expect(view).toMatch(/className="chat-chips shrink-0 border-t/);
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

  it("spends less of the phone on the hero", () => {
    /* 178px of a 575px viewport for a title, a pill and a sentence, while the
       conversation below it had 40. Each of these is reversed at `sm`, where
       178px of a 900px screen costs nothing. */
    expect(view).toMatch(/mb-3 flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:mb-4 sm:gap-4 sm:px-5 sm:py-4/);
    expect(view).toMatch(/text-base font-bold tracking-tight sm:text-\[19px\]/);
    /* The reset button stops wrapping onto a row of its own — 56px, the single
       biggest line item — by dropping its label. */
    expect(view).toMatch(/<span className="hidden sm:inline">New chat<\/span>/);
    expect(view).toMatch(/aria-label="New chat"/);
    /* And the left group shrinks rather than shoving it down there. */
    expect(view).toMatch(/flex min-w-0 flex-1 items-center gap-3 sm:gap-3\.5/);
    /* The orb sets the hero's floor, so it comes down too. */
    const orb = css.slice(css.indexOf(".chat-orb {"));
    expect(orb).toMatch(/@media \(max-width: 639\.98px\)[\s\S]{0,200}?\.chat-orb\s*\{[^}]*height:\s*38px/);
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
    expect(view).toMatch(/-mb-6 flex h-\[calc\(100dvh-88px\)\]/);
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
    expect(view).toMatch(/overflow-y-auto overscroll-contain p-5/);
  });
});

describe("the hero says only what is worth saying", () => {
  it("drops the counts line on a phone", () => {
    /**
     * Asked whether something more useful could replace it; the honest answer
     * was no. Anything actionable — what is due, who is waiting — is the Home
     * page's job, and repeating it here is the duplication this app keeps
     * having to remove. The counts are not a fact anybody acts on, and the
     * badge beside the title already carries the one thing that changes what
     * you do: whether the answers are live.
     *
     * Worth 32px on a 575px screen, handed to the conversation. Measured: hero
     * 99px to 79.
     */
    const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const counts = code.match(/knows\.contacts/g) ?? [];
    /* Exactly one place renders them, and it is the `sm:`-only line. */
    expect(counts.length).toBe(1);
    expect(code).toMatch(/hidden text-xs text-muted sm:block sm:truncate[\s\S]{0,200}?knows\.contacts/);
  });

  it("keeps the grounding claim on the desktop", () => {
    /* There it is one line in a wide strip, costs nothing, and is the page
       saying on its face that the answers come from real records. */
    expect(view).toMatch(/Answering from/);
    expect(view).toMatch(/meetings — live\./);
  });
});

describe("the suggestions get out of the way", () => {
  it("stand down the moment there is a draft", () => {
    /**
     * Asked for directly: once you are typing you should see the box and the
     * conversation, nothing else. Measured at 320x575 — transcript 125px with
     * them showing, 316px the moment a character is typed.
     */
    expect(view).toMatch(/const engaged = draft\.trim\(\)\.length > 0 \|\| items\.some\(\(m\) => m\.role === "user"\)/);
  });

  it("comes back after New chat", () => {
    /**
     * The bug the previous condition had. `items` is seeded with an assistant
     * greeting and `reset()` keeps it — `prev.slice(0, 1)` — so `items.length >
     * 0` was true on a freshly reset chat. Tapping New chat left the reader on
     * a greeting with nothing to tap and no empty state either, which is a
     * worse first run than the one they started with.
     *
     * A USER message is what ends the first run, and a greeting is not one.
     */
    expect(view).toMatch(/items\.some\(\(m\) => m\.role === "user"\)/);
    const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    /* `reset` still keeps the greeting — this test is about the condition, and
       would be vacuous if the seeding ever went away silently. */
    expect(code).toMatch(/prev\.slice\(0, 1\)/);
    expect(code).not.toMatch(/data-engaged=\{items\.length/);
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
