"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A dropdown that escapes whatever is clipping it.
 *
 * An `absolute` menu is clipped by the nearest ancestor with `overflow: hidden`,
 * and every list in this app lives in a `.card` that has exactly that — it is
 * what keeps rows from spilling past the rounded corners and what makes the
 * list scroll inside itself.
 *
 * Reported on the inbox: the sort and filter menus opened and were sliced off
 * at the bottom edge of the card. Measured at 393px with an empty list — the
 * card is 128px tall and the filter menu 230, so two of its seven rows were
 * visible and the rest simply did not exist. The taller the card, the less
 * often anyone notices, which is why it survived on the pages with long lists.
 *
 * Portalled to `document.body` and positioned `fixed`, it has no clipping
 * ancestor left. The trade is that it no longer moves with a scrolling parent,
 * so it closes on scroll rather than drifting away from its button.
 */
export function AnchoredMenu({
  anchor,
  open,
  onClose,
  width = 224,
  children,
  role = "menu",
}: {
  /** The element to hang from — usually the button that opened this. */
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
  role?: string;
}) {
  const [pos, setPos] = useState<{
    /* One of these, never both: opening upward has to pin the menu's BOTTOM to
       the button, and its height is not known until it has rendered. Setting
       `top` for that case would hang the menu downward from the button's top
       edge — over the button itself. */
    top?: number;
    bottom?: number;
    left: number;
    maxHeight: number;
  } | null>(null);

  /*
     Measured before paint, so the menu never renders at the wrong place and
     jumps. `useLayoutEffect` rather than `useEffect` for exactly that reason.
  */
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const gap = 8;
      const margin = 8;
      const below = window.innerHeight - r.bottom - gap - margin;
      const above = r.top - gap - margin;
      /* Open downward unless there is meaningfully more room the other way —
         a menu that flips on a two-pixel difference feels unstable. */
      const flip = below < 160 && above > below;
      const maxHeight = Math.max(120, flip ? above : below);

      /* Right-aligned to the button, then pulled back inside the viewport.
         Right alignment is what a control at the end of a toolbar wants; the
         clamp is what stops it hanging off the screen on a narrow phone. */
      let left = r.right - width;
      left = Math.min(left, window.innerWidth - width - margin);
      left = Math.max(margin, left);

      setPos(
        flip
          ? { bottom: window.innerHeight - r.top + gap, left, maxHeight }
          : { top: r.bottom + gap, left, maxHeight }
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchor, width]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    /* Closed rather than repositioned on scroll. Fixed to the viewport, it
       would otherwise sit still while its button slid away underneath. */
    const onScroll = () => onClose();
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, onClose]);

  if (!open || !pos || typeof document === "undefined") return null;

  return createPortal(
    <>
      {/* Click-away. A plain fixed layer under the menu, so the menu itself does
          not need a close button and the page behind cannot be operated by
          accident while it is open. */}
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="fixed inset-0 z-[60] cursor-default"
      />
      <div
        role={role}
        className="popover fixed z-[61] overflow-y-auto overscroll-contain p-1.5"
        style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width, maxHeight: pos.maxHeight }}
      >
        {children}
      </div>
    </>,
    document.body
  );
}
