import { Info } from "lucide-react";
import { Card } from "@/components/ui/Card";
import type { LeadCard as LeadCardType } from "@/data/leads";
import {
  leadAgeing,
  leadAnalytics,
  listLeadsWithStatus,
  type LeadAgeing,
  type LeadAnalytics,
} from "@/server/leads-view";
import { withTenantPage } from "@/server/tenant-session";
import { LeadCardsSection } from "./LeadCardsSection";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const { leads, stats, ageing } = await withTenantPage(async (q) => {
    const rows = await listLeadsWithStatus(q);
    return {
      leads: rows,
      stats: await leadAnalytics(q),
      // Derived from the rows already in hand — no second query, and the
      // ageing cannot disagree with the list it sits beside.
      ageing: leadAgeing(rows),
    };
  });


  return (
    /*
       On a phone the leads come first.

       Two analytics cards remain above the list in document order — feed and
       sources — and neither is what someone opens this page to see. The Sales
       Target card that used to sit here as well now lives on Reports, where a
       target belongs beside the other headline numbers; that alone took 407px
       off the top of this page.

       `flex flex-col sm:block` is the whole mechanism. Below `sm` this is a flex
       column, so the `order` classes below take effect; from `sm` it is a plain
       block again, where `order` is meaningless and the document order — the
       designed order — returns untouched.

       The spacing has to move with them. Every gap on this page used to be a
       margin on the item BELOW it, which is correct only while the document
       order holds: reversing two items with `order` leaves the margin attached
       to whichever item still declares it, not to the boundary it was meant to
       fill. Measured at 375px, the leads list ended at y=1721 and Lead's Feed
       began at y=1721 — the two cards butted flush, which reads as one card
       overlapping another. `gap-5` puts the spacing on the CONTAINER, where it
       belongs to the boundary rather than to an item, so it stays correct in
       either order. It is desktop-inert by construction: from `sm` this is a
       block box, and `gap` does nothing on a block box.
    */
    <div className="mx-auto flex max-w-[1500px] animate-fade-up flex-col gap-5 sm:block">
      {/* Page header. The bottom padding becomes the container's `gap` below
          `sm` — same 20px, counted once rather than twice. */}
      <div className="pb-0 pt-1 sm:pb-5">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Leads</h1>
        <p className="mt-1 text-sm text-muted">Track every lead, work your follow-ups, and close more deals.</p>
      </div>

      {/* Top row */}
      <div className="order-3 grid grid-cols-1 gap-5 sm:order-none @min-[960px]:grid-cols-2">
        <WaitingCard ageing={ageing} />
        <LeadSourcesCard stats={stats} />
      </div>

      {/* Lead cards (persisted). Wrapped only to carry the mobile ordering —
          the component itself is unchanged. */}
      <div className="order-2 sm:order-none">
        <LeadCardsSection leads={leads} />
      </div>
    </div>
  );
}

/* ---------------- Waiting on You ---------------- */

/**
 * Replaces "Lead's Feed", which was the same array as the list beside it —
 * same names, same companies, same statuses — re-sorted and cut to six. On a
 * phone that meant scrolling past fifteen leads to reach six of the same
 * leads, and it cost about 400px to say nothing new.
 *
 * This answers something the page could not answer at all. Every lead carries
 * a capture date and it appeared nowhere: the list tells you WHO is in the
 * pipeline, and nothing told you how long any of them had been sitting there,
 * which is the reading that actually drives a call.
 *
 * Every figure is a count of records whose timestamp falls in a range — there
 * is nothing estimated and nothing derived from anything but `created_at`.
 * Leads with no usable date are counted separately and said out loud rather
 * than being given an invented age or dropped silently.
 */
function WaitingCard({ ageing }: { ageing: LeadAgeing }) {
  const total = ageing.dated;
  const max = Math.max(1, ...ageing.buckets.map((b) => b.count));
  const TONE: Record<string, string> = {
    week: "var(--green)",
    month: "var(--amber)",
    stale: "var(--red)",
  };

  return (
    <Card className="flex flex-col">
      <div className="mb-4">
        <h3 className="text-[15px] font-semibold tracking-tight">Waiting on You</h3>
        <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-faint">
          How long open leads have sat <Info className="h-3 w-3" />
        </p>
      </div>

      {total === 0 && ageing.undated === 0 ? (
        /* Not "0 days" — nothing is open, which is a different statement from
           everything being answered instantly. */
        <p className="flex-1 py-10 text-center text-sm text-faint">
          Nothing open. Every lead is either won or closed.
        </p>
      ) : (
        <>
          {/*
              One number, not two.

              An open-lead count was the obvious partner for it and would have
              been the THIRD copy of that figure on this page: the filter strip
              already shows Follow-up, and Lead Sources shows Open right beside
              this card. Replacing a duplicate panel with a duplicated number
              would have missed the point of removing the feed.
          */}
          <div className="rounded-2xl border border-[var(--border)] p-3 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">
              Typical wait
            </p>
            <p className="mt-0.5 text-2xl font-bold tabular-nums accent-text">
              {ageing.medianDays === null
                ? "—"
                : ageing.medianDays === 0
                  ? "<1 day"
                  : `${ageing.medianDays} day${ageing.medianDays === 1 ? "" : "s"}`}
            </p>
            <p className="mt-0.5 text-[11px] text-faint">
              median across {total} open lead{total === 1 ? "" : "s"}
            </p>
          </div>

          <div className="mt-5 flex flex-1 flex-col justify-center gap-4">
            {ageing.buckets.map((b) => (
              <div key={b.id} className="flex items-center gap-3">
                <span className="w-28 shrink-0 truncate text-xs text-muted">{b.label}</span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(b.count / max) * 100}%`, background: TONE[b.id] }}
                  />
                </div>
                <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums">
                  {b.count}
                </span>
              </div>
            ))}

            <div className="mt-auto border-t border-[var(--border)] pt-4">
              {ageing.oldest ? (
                <>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">
                    Longest waiting
                  </p>
                  <p className="mt-1 truncate text-sm font-bold">{ageing.oldest.name}</p>
                  <p className="truncate text-[11px] text-faint">
                    {ageing.oldest.company ? `${ageing.oldest.company} · ` : ""}
                    {/* "0 days" is accurate and reads like a placeholder. A
                        lead captured today has waited no days, and "today" is
                        the same fact in the words a person would use. */}
                    {ageing.oldest.days === 0
                      ? "captured today"
                      : `${ageing.oldest.days} day${ageing.oldest.days === 1 ? "" : "s"}`}
                  </p>
                </>
              ) : (
                <p className="text-[11px] text-faint">
                  No open lead carries a capture date yet.
                </p>
              )}

              {/* Said out loud, because otherwise the bars would quietly
                  disagree with the Open count on the panel beside this one. */}
              {ageing.undated > 0 && (
                <p className="mt-2 text-[11px] text-faint">
                  {ageing.undated} without a capture date, not counted above.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}


/* ---------------- Lead Sources ---------------- */

/**
 * Replaces the old "Lead Response & Conversion Times" card, which reported an
 * average response time, leads-per-week and unassigned counts. The app records
 * none of those — there is no first-contact timestamp and no assignment — so
 * rather than keep inventing them, this shows where leads actually came from,
 * which every lead does carry.
 */
function LeadSourcesCard({ stats }: { stats: LeadAnalytics }) {
  const max = Math.max(1, ...stats.bySource.map((s) => s.count));
  const best = stats.bySource.reduce(
    (top, s) => (s.count > top.count ? s : top),
    stats.bySource[0] ?? { label: "—" as LeadCardType["source"], count: 0, pct: 0 }
  );
  const colors = ["var(--accent)", "var(--purple)", "var(--amber)", "var(--green)"];
  return (
    <Card className="flex flex-col">
      <div className="mb-4">
        <h3 className="text-[15px] font-semibold tracking-tight">Lead Sources</h3>
        <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-faint">
          Where leads come from <Info className="h-3 w-3" />
        </p>
      </div>

      <div className="grid grid-cols-4 gap-2 rounded-2xl border border-[var(--border)] p-3 text-center">
        <MiniStat label="Total" value={String(stats.total)} accent />
        <MiniStat label="New" value={String(stats.fresh)} />
        <MiniStat label="Open" value={String(stats.open)} />
        <MiniStat label="Won" value={String(stats.closed)} />
      </div>

      {stats.bySource.length === 0 ? (
        <p className="flex-1 py-10 text-center text-sm text-faint">No leads yet.</p>
      ) : (
        <div className="mt-5 flex flex-1 flex-col justify-center gap-4">
          {stats.bySource.map((b, i) => (
            <div key={b.label} className="flex items-center gap-3">
              <span className="w-28 shrink-0 truncate text-xs text-muted">{b.label}</span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(b.count / max) * 100}%`, background: colors[i % colors.length] }}
                />
              </div>
              <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums">
                {b.count} <span className="text-[10px] font-normal text-faint">({b.pct}%)</span>
              </span>
            </div>
          ))}

          {/* The panel used to end here with a tall gap below the bars. The
              best and worst performing source is a real reading of the same
              data, and it is what the bars are actually for. */}
          <div className="mt-auto border-t border-[var(--border)] pt-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">
                  Top source
                </p>
                <p className="mt-1 truncate text-sm font-bold text-green">{best.label}</p>
                <p className="text-[11px] text-faint">
                  {best.count} lead{best.count === 1 ? "" : "s"} · {best.pct}%
                </p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">
                  Conversion
                </p>
                <p className="mt-1 text-sm font-bold" style={{ color: "var(--accent)" }}>
                  {stats.conversion === null ? "—" : `${stats.conversion}%`}
                </p>
                <p className="text-[11px] text-faint">
                  {stats.closed} of {stats.total} won
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</p>
      <p className={`mt-1 text-lg font-bold ${accent ? "text-amber" : ""}`}>{value}</p>
    </div>
  );
}
