"use client";

import { useLayoutEffect, useState } from "react";

export type AnchoredPosition = {
  /* One of these, never both: opening upward has to pin the panel's BOTTOM to
     the anchor, and its height is not known until it has rendered. Setting
     `top` for that case would hang it downward from the anchor's top edge —
     over the anchor itself. */
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
};

/**
 * Where to put a panel that hangs off a control, in viewport coordinates.
 *
 * Anything `absolute` in this app is sliced off by the first ancestor with
 * `overflow: hidden` — every list lives in a `.card` that has it for its
 * rounded corners, and the message reader has it again on the body it scrolls.
 * The only reliable answer is to portal the panel out and position it `fixed`,
 * which means computing the position by hand.
 *
 * Shared because it has now been needed twice and got missed the second time:
 * the forward field's suggestion list was written the obvious way and measured
 * at 393x850 running to y=1001 on an 850px screen, with two of its six rows
 * reachable — the same defect, in the feature built to fix the last one. The
 * clamping and the flip are the fiddly part, and they belong in one place.
 */
export function useAnchoredPosition(
  anchor: HTMLElement | null,
  open: boolean,
  options: {
    /** Fixed width. Omit to match the anchor — what a field's own list wants. */
    width?: number;
    /** `end` right-aligns to the anchor (a toolbar menu); `start` left-aligns. */
    align?: "start" | "end";
  } = {}
): AnchoredPosition | null {
  const { width, align = "end" } = options;
  const [pos, setPos] = useState<AnchoredPosition | null>(null);

  /* Measured before paint, so the panel never renders in the wrong place and
     then jumps. `useLayoutEffect` rather than `useEffect` for exactly that. */
  useLayoutEffect(() => {
    /* No `setPos(null)` here. Clearing it would be a synchronous setState in an
       effect — a cascading render the compiler rejects — and it buys nothing:
       every caller renders the panel only while it is open, and this effect
       re-places it before the next paint. */
    if (!open || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const gap = 8;
      const margin = 8;
      const w = width ?? r.width;

      /**
       * The band the reader can actually see.
       *
       * `innerHeight` is the LAYOUT viewport, which on iOS still counts the
       * strip the keyboard is covering — so "room below" included space behind
       * the keyboard. The visual viewport is what is genuinely visible, and its
       * `offsetTop` is how far Safari has panned the page up to reveal the
       * focused field. Both are in layout coordinates, which is what
       * `getBoundingClientRect` and a `fixed` panel are positioned in, so they
       * can be compared directly.
       */
      const vv = window.visualViewport;
      const viewTop = vv ? vv.offsetTop : 0;
      const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      const viewLeft = vv ? vv.offsetLeft : 0;
      const viewRight = vv ? vv.offsetLeft + vv.width : window.innerWidth;

      const below = viewBottom - r.bottom - gap - margin;
      const above = r.top - viewTop - gap - margin;
      /* Open downward unless there is meaningfully more room the other way — a
         panel that flips on a two-pixel difference feels unstable. */
      const flip = below < 160 && above > below;
      const maxHeight = Math.max(120, flip ? above : below);

      let left = align === "end" ? r.right - w : r.left;
      left = Math.min(left, viewRight - w - margin);
      left = Math.max(viewLeft + margin, left);

      setPos(
        flip
          ? { bottom: window.innerHeight - r.top + gap, left, width: w, maxHeight }
          : { top: r.bottom + gap, left, width: w, maxHeight }
      );
    };
    place();
    /* Repositioned rather than closed. Fixed to the viewport, the panel would
       otherwise sit still while its anchor slid away underneath — and closing
       instead is wrong for a field, where iOS scrolls the page to reveal the
       input the moment the keyboard opens. Capture phase, because the scroll
       that matters happens inside the card, not on `window`. */
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    /**
     * And the visual viewport, which is the one that moves for a keyboard.
     *
     * Opening the keyboard pans the page to reveal the focused field and fires
     * NEITHER `window.resize` nor `window.scroll`. The list was therefore
     * placed once, on focus and before the keyboard existed, and then left
     * where it was: photographed on an iPhone sitting about 96px clear of its
     * own field, floating over the card above it. These two events are the only
     * notice a page gets that the keyboard changed the visible area.
     */
    const vv = window.visualViewport;
    vv?.addEventListener("resize", place);
    vv?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      vv?.removeEventListener("resize", place);
      vv?.removeEventListener("scroll", place);
    };
  }, [open, anchor, width, align]);

  return pos;
}
