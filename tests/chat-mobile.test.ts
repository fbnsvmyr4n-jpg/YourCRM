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
    expect(view).toMatch(/<p className="mt-1 text-xs text-muted sm:hidden">/);
    const phoneLine = view.slice(view.indexOf('mt-1 text-xs text-muted sm:hidden'));
    expect(phoneLine.slice(0, 400)).not.toMatch(/truncate/);
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
    expect(view).toMatch(/className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5"/);
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
    expect(view).toMatch(/data-conversation=\{items\.length > 0 \? "true" : undefined\}/);
    const block = css.slice(css.indexOf("@media (max-width: 639.98px)", css.indexOf(".chat-chips")));
    expect(block).toMatch(/\.chat-chips\[data-conversation="true"\]\s*\{[^}]*display:\s*none/);
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
