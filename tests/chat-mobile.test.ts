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
       the claim, so it wraps on a phone and only truncates from `sm`. */
    expect(view).toMatch(/text-xs text-muted sm:truncate/);
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
