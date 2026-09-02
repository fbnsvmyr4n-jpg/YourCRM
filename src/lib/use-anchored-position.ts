"use client";

import { useLayoutEffect, useState } from "react";

export type AnchoredPosition = {
  /**
   * Always `top`, measured from the anchor and nothing else.
   *
   * Opening upward used to pin the panel's BOTTOM with `bottom: innerHeight -
   * anchor.top`, because the panel's height is not known before it renders.
   * That works only while `innerHeight` means the same thing to this code and
   * to the browser laying the panel out — and on iOS it stops meaning the same
   * thing the moment the keyboard appears. The panel was left stranded about
   * 100px above its field, over the card above it, twice.
   *
   * `translateY(-100%)` solves the unknown height without asking the viewport
   * anything: the browser resolves the percentage against the panel's own
   * rendered box. So placement now depends on the anchor's rectangle alone,
   * which is the one measurement that cannot disagree with itself.
   */
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  /** `above` needs the caller to shift the panel up by its own height. */
  placement: "above" | "below";
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
      /**
       * Close enough to read as part of the field.
       *
       * Measured off an iPhone recording: from the last suggestion's text to
       * the top of the input was about 24px of nothing — the row's own padding,
       * then the list's, then this gap, stacked. Individually each was
       * defensible; together they detached the list from the field it belongs
       * to, and it read as floating over the card above rather than hanging off
       * the input.
       *
       * 4px still separates the two surfaces; 8 was reading as a margin.
       */
      const gap = 4;
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
          ? { top: r.top, left, width: w, maxHeight, placement: "above" }
          : { top: r.bottom + gap, left, width: w, maxHeight, placement: "below" }
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

/**
 * Which way a field's own suggestion list should open, and how tall it may be.
 *
 * Deliberately NOT a position. Three separate attempts to compute where a
 * suggestion list belongs — pinning its bottom, tracking the visual viewport,
 * shifting it by its own height — each fixed one device and failed on another,
 * because every one of them re-derives in JavaScript a relationship the browser
 * already maintains for free: a child positioned against its parent.
 *
 * The list is now a child of the field, `absolute` above or below it, so it
 * moves with the field by construction. Nothing here can strand it: the worst a
 * wrong answer can do is open it the less convenient way round, still attached.
 * That is the difference between a bug and a preference.
 *
 * Measured against the VISIBLE viewport, so the space a keyboard is covering is
 * not mistaken for room.
 */
export function useDropDirection(anchor: HTMLElement | null, open: boolean) {
  const [state, setState] = useState<{ up: boolean; maxHeight: number }>({
    up: false,
    maxHeight: 280,
  });

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const measure = () => {
      const r = anchor.getBoundingClientRect();
      const vv = window.visualViewport;
      const viewTop = vv ? vv.offsetTop : 0;
      const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;

      const below = viewBottom - r.bottom - 12;
      const above = r.top - viewTop - 12;
      /* Downward unless there is meaningfully more room the other way — a list
         that flips on a two-pixel difference feels unstable. */
      const up = below < 160 && above > below;
      /* Capped so a long list never fills the screen, floored so it is always
         worth opening. */
      setState({ up, maxHeight: Math.max(120, Math.min(320, up ? above : below)) });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", measure);
    vv?.addEventListener("scroll", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      vv?.removeEventListener("resize", measure);
      vv?.removeEventListener("scroll", measure);
    };
  }, [open, anchor]);

  return state;
}
