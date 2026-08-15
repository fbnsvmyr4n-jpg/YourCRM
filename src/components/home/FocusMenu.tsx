"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import type { Tone } from "@/components/ui/tone";

export type FocusItem = {
  icon: string;
  /** Keyed to the shared tone palette, so it can index `toneStyles` directly. */
  tone: Tone;
  title: string;
  sub: string;
  /** Where this focus lives in the CRM. */
  href: string;
  /** Short label for the menu, where the full sentence is too long. */
  menuLabel: string;
};

/**
 * The ⋯ on Today's Focus. Was a decorative icon; it now lists the same
 * destinations as the cards so the whole day's work is one click from here.
 */
export function FocusMenu({ items }: { items: FocusItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="Jump to a focus"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="focus-ring grid h-7 w-7 place-items-center rounded-lg text-faint transition-colors hover:bg-[var(--raise)] hover:text-[var(--text)]"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open && (
        <div className="popover absolute right-0 top-9 z-30 w-56 overflow-hidden p-0">
          <p className="border-b border-[var(--border)] px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
            Jump to
          </p>
          {items.map((f) => (
            <Link
              key={f.title}
              href={f.href}
              onClick={() => setOpen(false)}
              className="block px-3.5 py-2.5 text-sm transition-colors hover:bg-[var(--raise)]"
            >
              {f.menuLabel}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
