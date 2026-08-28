"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { clsx } from "@/lib/clsx";

/**
 * A dashboard section that is folded away on a phone and always open above it.
 *
 * The dashboard renders ten cards. On a desktop they sit in two columns and
 * read as a dashboard; collapsed to one column they become ten full-width
 * cards stacked end to end, every one of them expanded, competing for the same
 * attention. That is the "cluttered and overstimulating" — not any single card,
 * but all of them shouting at once with no hierarchy between them.
 *
 * So on a phone the essentials stay open — the time, the greeting and its
 * counts, today's focus, the quick actions — and everything that is a *report*
 * rather than a *next action* folds behind its own title. The page becomes a
 * short list of labelled things, and the reader opens the one they came for.
 *
 * `sm:block` on the body is unconditional, and the control is `sm:hidden`, so
 * from `sm` up the layout never consults this state and the desktop dashboard
 * is exactly what it was.
 */
export function MobileSection({
  title,
  hint,
  children,
  defaultOpen = false,
}: {
  title: string;
  /** A count or figure worth seeing without opening it. */
  hint?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <section className="flex flex-col gap-3 sm:contents">
      {/* The header exists only on a phone. On a desktop these cards carry
          their own headings and a second one would be a duplicate. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        className="btn-soft focus-ring flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left sm:hidden"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{title}</span>
          {hint && <span className="mt-0.5 block truncate text-[11px] text-faint">{hint}</span>}
        </span>
        <ChevronDown
          className={clsx(
            "h-4 w-4 shrink-0 text-faint transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      <div id={id} className={clsx("sm:contents", open ? "block" : "hidden")}>
        {children}
      </div>
    </section>
  );
}
