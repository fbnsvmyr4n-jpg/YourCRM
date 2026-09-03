import Link from "next/link";
import { Settings2, Target } from "lucide-react";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";

/**
 * Progress against the monthly target.
 *
 * It lived on the Leads page, under a heading reading "Sales Target & Leads" —
 * one page doing two jobs. On a phone it was 1,101px tall on an 852px screen,
 * so it stood between the user and the leads it shared a page with, and even
 * collapsed it was answering a question nobody had come to that page to ask.
 *
 * Reports is where it belongs. That page already carries Revenue Won, Open
 * Pipeline, Win Rate and Average Deal — every measure of how the business is
 * doing except the one that says whether it is on track. This fills the gap
 * rather than duplicating anything, and it leaves the Leads page to be about
 * leads.
 *
 * Two things came off in the move. The mobile collapse, because on Reports the
 * detail IS the reason you are there. And the six-week revenue chart, because
 * Reports renders that same chart, larger, directly below this card — on Leads
 * it was the only chart on the page; here it was the same data twice.
 *
 * The figures are month-to-date and deliberately ignore the period control at
 * the top of the page. A monthly target is about this calendar month; if it
 * followed the selected window, "68% of target" would mean something different
 * depending on a dropdown that has nothing to do with the target.
 */
export function SalesTargetCard({
  pct,
  won,
  target,
}: {
  pct: number | null;
  won: number;
  target: number;
}) {
  return (
    <Card>
      <CardHeader
        title="Sales Target"
        icon={<Target className="h-[18px] w-[18px] text-accent" />}
        action={<CardMeta>This month</CardMeta>}
      />

      {/*
          Side by side once there is room for it.

          This card was built as a one-third-width column on the Leads page, so
          stacking its blocks was the only option there. Here it spans the full
          content width — about 1,090px at 1280 — and stacked blocks left a very
          wide, very empty card. The threshold is a container query, not a media
          query, because the width that matters is the width of the card, which
          is the viewport minus the sidebar.
      */}
      <div className="grid grid-cols-1 gap-5 @min-[720px]:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] @min-[720px]:items-center">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
              Target Amount
            </p>
            <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums">
              ${target.toLocaleString()}
            </p>
            <Link
              href="/settings"
              className="focus-ring mt-2 inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-accent"
            >
              Monthly Target <Settings2 className="h-3 w-3" />
            </Link>
          </div>
          <span
            className="shrink-0 rounded-xl border px-3 py-1.5 text-sm font-semibold text-green"
            style={{ borderColor: "var(--green)", background: "var(--green-soft)" }}
            title="Won so far this month"
          >
            ${won.toLocaleString()}
          </span>
        </div>

        <div className="rounded-2xl border border-[var(--border)] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Progress</p>
          <p className="accent-text mt-1 text-3xl font-bold tabular-nums">
            {pct === null ? "—" : `${pct}%`}
          </p>
          <p className="mt-2 text-xs text-muted">
            {target > 0
              ? `$${won.toLocaleString()} of $${target.toLocaleString()} this month`
              : "Set a monthly target in Settings to track progress"}
          </p>

          {/* Gradient progress bar */}
          <div className="mt-4">
            <div className="relative h-3 w-full overflow-hidden rounded-full">
              <div
                className="absolute inset-0"
                style={{
                  background: "linear-gradient(90deg,#e5484d 0%,#f5a524 45%,#16a34a 100%)",
                  opacity: 0.85,
                }}
              />
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-white shadow"
                style={{ left: `${pct ?? 0}%` }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-faint">
              <span>Start</span>
              <span>Target</span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
