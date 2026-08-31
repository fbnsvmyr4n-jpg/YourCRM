"use client";

import { useEffect, useState } from "react";

/**
 * The measured width of an element, for layout decisions React has to make.
 *
 * Watches the ELEMENT rather than the viewport, because that is what these
 * pages actually key off: their breakpoints are container queries
 * (`@min-[720px]`), and the container is the viewport minus the sidebar. A
 * viewport media query would disagree with the layout through the whole range
 * where the sidebar is present but the content is still narrow — claiming two
 * columns while the reader is looking at one.
 *
 * Returns the width rather than a boolean so one observer can answer several
 * questions. The contacts grid asks two of it — whether the panels are stacked,
 * and whether Contact Activity folds — and the inbox asks whether the reader
 * opens in place or as its own screen.
 *
 * 0 until measured. Every threshold at the call sites is a `<`, so an unmeasured
 * element behaves as the narrow case, which is the safe way round: a back button
 * that appears for an instant is a smaller wrong than a desktop that renders as
 * a phone.
 *
 * Lifted out of ContactsView when the inbox needed the same thing. A second
 * copy of a ResizeObserver is how two pages start disagreeing about what
 * "narrow" means.
 */
export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
