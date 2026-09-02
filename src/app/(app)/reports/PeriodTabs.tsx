"use client";

import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "@/lib/clsx";
import { PERIODS, PERIOD_LABELS, type PeriodId } from "@/server/report-period";

/**
 * Which stretch of time the report covers.
 *
 * These were plain links. Every tap was a full navigation, and this page is
 * `force-dynamic` with six queries behind it, so the whole report was rebuilt
 * on the server before anything on screen acknowledged the tap — including the
 * highlight moving to the period that had been chosen. On a phone that is a
 * second or more of a button that appears not to have worked, which is exactly
 * how it was reported.
 *
 * The choice is now shown immediately and the fetch happens behind it. Nothing
 * about the data changes: the same URL, the same server render, the same
 * figures. What changes is that the reader is told they were heard.
 *
 * Still a real URL underneath, because a period worth looking at is worth
 * sending to somebody — "look at July" should be a link, not a description of
 * which buttons to press.
 */
export function PeriodTabs({ current }: { current: PeriodId }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  /* Cleared automatically when the server render arrives with the real value,
     so a failed navigation cannot leave the row lying about what it shows. */
  const [shown, setShown] = useOptimistic(current);

  return (
    <div
      aria-busy={pending}
      className={clsx(
        /* A grid, not a wrapping row: six labels of different lengths let the
           available width decide where the breaks fall, which put "All time"
           on a line of its own on a phone. Equal columns break the same way
           everywhere. */
        "tab-row mt-3 grid grid-cols-3 gap-1.5 @min-[560px]:grid-cols-6 @min-[880px]:flex @min-[880px]:flex-wrap @min-[880px]:items-center @min-[880px]:gap-1",
        /* Only while a period is actually loading, and only just enough to read
           as busy — a spinner over a report that is about to redraw anyway
           would be more movement, not more information. */
        pending && "opacity-60 transition-opacity"
      )}
    >
      {PERIODS.map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={shown === id}
          onClick={() => {
            if (id === shown) return;
            startTransition(() => {
              setShown(id);
              router.push(id === "all-time" ? "/reports" : `/reports?period=${id}`, { scroll: false });
            });
          }}
          className={clsx(
            "focus-ring truncate rounded-full px-2.5 py-1.5 text-[11px] font-medium transition-colors @min-[880px]:px-3 @min-[880px]:py-1 @min-[880px]:text-xs",
            shown === id ? "text-accent" : "text-muted hover:text-[var(--text)]"
          )}
          style={shown === id ? { background: "var(--accent-soft)" } : undefined}
        >
          {PERIOD_LABELS[id]}
        </button>
      ))}
    </div>
  );
}
