import { Info, Target, Users } from "lucide-react";
import { AreaChart } from "@/components/ui/AreaChart";
import { Avatar } from "@/components/ui/Avatar";
import { Card, CardHeader } from "@/components/ui/Card";
import { toneStyles, type Tone } from "@/components/ui/tone";
import { type LeadCard as LeadCardType } from "@/data/leads";
import { leadAnalytics, listLeads, type LeadAnalytics } from "@/server/leads-repo";
import { weeklyRevenue, listWonDeals } from "@/server/deals-repo";
import { getSettings } from "@/server/settings-repo";
import { LeadCardsSection } from "./LeadCardsSection";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const [leads, stats, wonDeals, revenueSeries, settings] = await Promise.all([
    listLeads(),
    leadAnalytics(),
    listWonDeals(),
    weeklyRevenue(),
    getSettings(),
  ]);
  const monthlyTarget = settings.monthlyTarget;

  // Progress against target is real money from real won deals — the same
  // source the dashboard reports, so the two can never disagree.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const wonThisMonth = wonDeals
    .filter((d) => Date.parse(d.wonAt) >= monthStart.getTime())
    .reduce((sum, d) => sum + d.value, 0);
  const pct = Math.min(100, Math.round((wonThisMonth / monthlyTarget) * 100));

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-up">
      {/* Page header */}
      <div className="pb-5 pt-1">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Sales Target &amp; Leads</h1>
        <p className="mt-1 text-sm text-muted">Track performance, manage leads, and close more deals.</p>
      </div>

      {/* Top row */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.05fr_1.1fr_0.92fr]">
        <SalesTargetCard pct={pct} won={wonThisMonth} target={monthlyTarget} series={revenueSeries} />
        <LeadsFeedCard leads={leads} />
        <LeadSourcesCard stats={stats} />
      </div>

      {/* Stat tiles — counted from persisted leads */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="All Leads" value={stats.total} sub="Total leads" tone="neutral" />
        <StatTile
          label="New Leads"
          value={stats.newThisWeekUnknown ? "—" : stats.newThisWeek}
          sub={stats.newThisWeekUnknown ? "No capture dates yet" : "Last 7 days"}
          tone="purple"
        />
        <StatTile label="Follow-up Required" value={stats.open} sub="Action needed" tone="red" />
        <StatTile
          label="Closed Leads"
          value={stats.closed}
          sub={stats.conversion === null ? "None yet" : `${stats.conversion}% conversion`}
          tone="green"
        />
      </div>

      {/* Lead cards (persisted) */}
      <LeadCardsSection leads={leads} />
    </div>
  );
}

/* ---------------- Sales Target ---------------- */

function SalesTargetCard({
  pct,
  won,
  target,
  series,
}: {
  pct: number;
  won: number;
  target: number;
  series: { label: string; value: number }[];
}) {
  return (
    <Card>
      <CardHeader
        title="Sales Target"
        icon={<Target className="h-[18px] w-[18px] text-accent" />}
      />
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Target Amount</p>
          <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums">
            ${target.toLocaleString()}
          </p>
          <p className="mt-2 text-xs text-muted">Monthly Target</p>
        </div>
        <span
          className="rounded-xl border px-3 py-1.5 text-sm font-semibold text-green"
          style={{ borderColor: "var(--green)", background: "var(--green-soft)" }}
        >
          ${won.toLocaleString()}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-[130px_minmax(0,1fr)]">
        <div className="rounded-2xl border border-[var(--border)] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Progress</p>
          <p className="accent-text mt-1 text-3xl font-bold tabular-nums">{pct}%</p>
          <p className="mt-2 text-xs text-muted">
            ${won.toLocaleString()} of ${target.toLocaleString()} this month
          </p>
        </div>
        <div className="min-w-0">
          <AreaChart data={series} height={180} ticks={3} />
        </div>
      </div>

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
            style={{ left: `${pct}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-faint">
          <span>Start</span>
          <span>Target</span>
        </div>
      </div>
    </Card>
  );
}

/* ---------------- Lead's Feed ---------------- */

const STATUS_DOT: Record<string, string> = {
  "Follow-up Required": "var(--red)",
  Closed: "var(--green)",
};

/**
 * Real leads, newest first. The old version rendered a hardcoded `leadsFeed`
 * array complete with invented revenue figures, call durations and
 * cold/mid/hot "temperature" badges — none of which the app records.
 */
function LeadsFeedCard({ leads }: { leads: LeadCardType[] }) {
  const rows = leads.slice(0, 6);
  return (
    <Card className="flex flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold tracking-tight">Lead&apos;s Feed</h3>
        <div className="flex items-center gap-3 text-[11px] text-muted">
          <Legend color="var(--red)" label="Follow-up" />
          <Legend color="var(--green)" label="Closed" />
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
                <span
                  className="w-fit rounded-md px-2 py-0.5 text-[10px] font-semibold"
                  style={{
                    background: l.status === "Closed" ? "var(--green-soft)" : "var(--red-soft)",
                    color: l.status === "Closed" ? "var(--green)" : "var(--red)",
                  }}
                >
                  {l.status}
                </span>
                <p className="mt-1 truncate text-xs text-faint">Source: {l.source}</p>
              </div>
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: STATUS_DOT[l.status] ?? "var(--border-strong)" }}
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
  const colors = ["var(--accent)", "var(--purple)", "var(--amber)", "var(--green)"];
  return (
    <Card className="flex flex-col">
      <div className="mb-4">
        <h3 className="text-[15px] font-semibold tracking-tight">Lead Sources</h3>
        <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-faint">
          Where leads come from <Info className="h-3 w-3" />
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-2xl border border-[var(--border)] p-3 text-center">
        <MiniStat label="Total" value={String(stats.total)} accent />
        <MiniStat label="Open" value={String(stats.open)} />
        <MiniStat label="Closed" value={String(stats.closed)} />
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

/* ---------------- Stat tiles ---------------- */

function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  /** String so a tile can honestly render "—" when the data can't answer it. */
  value: number | string;
  sub: string;
  tone: Tone | "neutral";
}) {
  const color = tone === "neutral" ? "var(--text-muted)" : toneStyles[tone].color;
  const soft = tone === "neutral" ? "var(--raise)" : toneStyles[tone].soft;
  return (
    <div
      className="card flex items-center justify-between gap-3 p-5"
      style={{ background: `linear-gradient(135deg, ${soft}, transparent 90%)` }}
    >
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-xl" style={{ background: soft }}>
          <Users className="h-5 w-5" style={{ color }} />
        </span>
        <div className="leading-tight">
          <p className="text-sm font-semibold">{label}</p>
          <p className="text-xs text-faint">{sub}</p>
        </div>
      </div>
      <span className="text-3xl font-bold tabular-nums" style={{ color }}>
        {/* Only pad real counts — padding a placeholder like "—" renders "0—". */}
        {typeof value === "number" ? String(value).padStart(2, "0") : value}
      </span>
    </div>
  );
}

