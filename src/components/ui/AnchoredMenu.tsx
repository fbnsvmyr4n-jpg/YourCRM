"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition } from "@/lib/use-anchored-position";

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
  /* Right-aligned to the button — what a control at the end of a toolbar wants.
     The clamping and the flip live in the hook, shared with the suggestion list
     on the forward field, which needs exactly the same arithmetic. */
  const pos = useAnchoredPosition(anchor, open, { width, align: "end" });

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
        style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
      >
        {children}
      </div>
    </>,
    document.body
  );
}
