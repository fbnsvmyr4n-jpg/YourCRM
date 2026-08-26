import { Info } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { STATUS_TONE, type LeadCard as LeadCardType } from "@/data/leads";
import { leadAnalytics, listLeadsWithStatus, type LeadAnalytics } from "@/server/leads-view";
import { withTenantPage } from "@/server/tenant-session";
import { LeadCardsSection } from "./LeadCardsSection";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const { leads, stats } = await withTenantPage(async (q) => ({
    leads: await listLeadsWithStatus(q),
    stats: await leadAnalytics(q),
  }));


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
    */
    <div className="mx-auto flex max-w-[1500px] animate-fade-up flex-col sm:block">
      {/* Page header */}
      <div className="pb-5 pt-1">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Leads</h1>
        <p className="mt-1 text-sm text-muted">Track every lead, work your follow-ups, and close more deals.</p>
      </div>

      {/* Top row */}
      <div className="order-3 grid grid-cols-1 gap-5 sm:order-none @min-[960px]:grid-cols-2">
        <LeadsFeedCard leads={leads} />
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

/* ---------------- Lead's Feed ---------------- */

/**
 * Real leads, newest first. The old version rendered a hardcoded `leadsFeed`
 * array complete with invented revenue figures, call durations and
 * cold/mid/hot "temperature" badges — none of which the app records.
 */
function LeadsFeedCard({ leads }: { leads: LeadCardType[] }) {
  // New leads first — they are the ones nobody has touched yet — then
  // follow-ups, then wins.
  const order: Record<string, number> = { "New Lead": 0, "Follow-up Required": 1, "Closed Won": 2 };
  const rows = [...leads]
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
    .slice(0, 6);
  return (
    <Card className="flex flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold tracking-tight">Lead&apos;s Feed</h3>
        {/* New Leads belong in the feed too — it previously showed only
            follow-ups and closed won, so a brand new lead was invisible on the
            very panel meant to surface incoming work. */}
        <div className="flex items-center gap-3 text-[11px] text-muted">
          <Legend color="var(--accent)" label="New" />
          <Legend color="var(--amber)" label="Follow-up" />
          <Legend color="var(--green)" label="Won" />
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="flex-1 py-10 text-center text-sm text-faint">No leads yet.</p>
      ) : (
        <div className="flex flex-1 flex-col">
          {rows.map((l, i) => (
            <div
              key={l.id}
              className={`flex items-center gap-3 py-3 ${i === rows.length - 1 ? "" : "border-b border-[var(--border)]"}`}
            >
              <Avatar initials={l.initials} color={l.color} size="sm" />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-sm font-semibold">{l.name}</p>
                <p className="truncate text-xs text-faint">{l.company}</p>
              </div>
              <div className="hidden min-w-0 flex-1 sm:block">
                {/* `inline-block`, not the default `inline`: on an inline
                    element `w-fit` is inert and vertical padding doesn't affect
                    line height, so a wrapped badge bleeds over the line below
                    it. `whitespace-nowrap` keeps it on one line. */}
                <span
                  className="inline-block w-fit whitespace-nowrap rounded-md px-2 py-0.5 text-[10px] font-semibold"
                  style={{
                    background: STATUS_TONE[l.status]?.soft ?? "var(--raise)",
                    color: STATUS_TONE[l.status]?.color ?? "var(--text-muted)",
                  }}
                >
                  {l.status}
                </span>
                <p className="mt-1 truncate text-xs text-faint">Source: {l.source}</p>
              </div>
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: STATUS_TONE[l.status]?.color ?? "var(--border-strong)" }}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
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
