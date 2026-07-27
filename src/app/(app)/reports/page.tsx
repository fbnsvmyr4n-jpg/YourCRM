import { Download, TrendingUp, Trophy, Users, Wallet } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Card, CardHeader } from "@/components/ui/Card";
import { STAGES } from "@/data/deals";
import { listContacts } from "@/server/contacts-repo";
import { listDeals } from "@/server/deals-repo";
import { listLeads } from "@/server/leads-repo";
import { listMeetings, meetingAnalytics } from "@/server/meetings-repo";

export const dynamic = "force-dynamic";

function fullMoney(n: number) {
  return `$${Math.round(n).toLocaleString()}`;
}
function compactMoney(n: number) {
  if (n >= 1000) {
    const k = n / 1000;
    return `$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return `$${n}`;
}

export default async function ReportsPage() {
  const [contacts, leads, meetings, deals, meetingStats] = await Promise.all([
    listContacts(),
    listLeads(),
    listMeetings(),
    listDeals(),
    // Share the Meetings page's calculation rather than deriving a second one
    // here — two pages disagreeing about "show rate" is worse than either
    // number being slightly different from what someone expected.
    meetingAnalytics(),
  ]);

  // Pipeline
  const pipelineByStage = STAGES.map((s) => {
    const rows = deals.filter((d) => d.stage === s.id);
    return { ...s, count: rows.length, value: rows.reduce((a, d) => a + d.value, 0) };
  });
  const maxStageValue = Math.max(1, ...pipelineByStage.map((s) => s.value));
  const openValue = deals.filter((d) => d.stage !== "won").reduce((a, d) => a + d.value, 0);
  const wonDeals = deals.filter((d) => d.stage === "won");
  const wonValue = wonDeals.reduce((a, d) => a + d.value, 0);
  const winRate = deals.length ? Math.round((wonDeals.length / deals.length) * 100) : 0;
  const avgDeal = deals.length ? Math.round(deals.reduce((a, d) => a + d.value, 0) / deals.length) : 0;

  // Lead sources
  const sources = (["Google Ads", "Facebook", "Referral"] as const).map((src, i) => ({
    label: src,
    value: leads.filter((l) => l.source === src).length,
    color: ["var(--accent)", "var(--amber)", "var(--purple)"][i],
  }));

  // Contacts breakdown
  const clientCount = contacts.filter((c) => c.type === "client").length;
  const leadCount = contacts.filter((c) => c.type === "lead").length;
  const contactSegments = [
    { label: "Clients", value: clientCount, color: "var(--green)" },
    { label: "Leads", value: leadCount, color: "var(--purple)" },
  ];

  // Lead status
  const closedLeads = leads.filter((l) => l.status === "Closed").length;
  const followupLeads = leads.filter((l) => l.status === "Follow-up Required").length;

  // Meeting performance
  const online = meetingStats.byType.online;
  const inPerson = meetingStats.byType.inPerson;
  // "—" when no outcome has been recorded: an unearned 0% would read as bad
  // performance rather than as missing data.
  const showRate = meetingStats.showRate === null ? "—" : `${meetingStats.showRate}%`;

  // Top deals
  const topDeals = [...deals].sort((a, b) => b.value - a.value).slice(0, 5);

  const kpis = [
    { icon: <Wallet className="h-5 w-5" />, label: "Open Pipeline", value: fullMoney(openValue), sub: `${deals.length - wonDeals.length} active deals`, tone: "var(--accent)", soft: "var(--accent-soft)" },
    { icon: <Trophy className="h-5 w-5" />, label: "Revenue Won", value: fullMoney(wonValue), sub: `${wonDeals.length} deals closed`, tone: "var(--green)", soft: "var(--green-soft)" },
    { icon: <TrendingUp className="h-5 w-5" />, label: "Win Rate", value: `${winRate}%`, sub: `of ${deals.length} total deals`, tone: "var(--purple)", soft: "var(--purple-soft)" },
    { icon: <Wallet className="h-5 w-5" />, label: "Avg Deal Size", value: fullMoney(avgDeal), sub: "across pipeline", tone: "var(--amber)", soft: "var(--amber-soft)" },
  ];

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-up">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-5 pt-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Reports &amp; Analytics</h1>
          <p className="mt-1 text-sm text-muted">Live insights across your pipeline, leads, and meetings.</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-soft focus-ring rounded-xl px-3.5 py-2 text-sm font-medium">This Quarter</button>
          <button className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium">
            <Download className="h-4 w-4 text-accent" /> Export
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((k) => (
          <div
            key={k.label}
            className="card p-5"
            style={{ background: `linear-gradient(135deg, ${k.soft}, transparent 85%)` }}
          >
            <span className="grid h-11 w-11 place-items-center rounded-xl" style={{ background: k.soft, color: k.tone }}>
              {k.icon}
            </span>
            <p className="mt-4 text-2xl font-bold tabular-nums sm:text-3xl">{k.value}</p>
            <p className="mt-1 text-sm font-medium">{k.label}</p>
            <p className="text-xs text-faint">{k.sub}</p>
          </div>
        ))}
      </div>

      {/* Row 2: funnel + sources */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="Pipeline by Stage" icon={<TrendingUp className="h-[18px] w-[18px] text-accent" />} />
          <div className="space-y-4 pt-1">
            {pipelineByStage.map((s) => (
              <div key={s.id}>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                    <span className="font-medium">{s.label}</span>
                    <span className="text-xs text-faint">({s.count})</span>
                  </span>
                  <span className="font-semibold tabular-nums">{fullMoney(s.value)}</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-[var(--border)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(s.value / maxStageValue) * 100}%`,
                      background: `linear-gradient(90deg, ${s.color}, ${s.color}bb)`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="flex flex-col">
          <CardHeader title="Lead Sources" icon={<Users className="h-[18px] w-[18px] text-accent" />} />
          <div className="flex flex-1 flex-col items-center justify-center gap-5 sm:flex-row sm:justify-around">
            <Donut segments={sources} centerLabel="Leads" centerValue={leads.length} />
            <Legend segments={sources} />
          </div>
        </Card>
      </div>

      {/* Row 3: contacts + lead status + meetings */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="flex flex-col">
          <CardHeader title="Contacts" />
          <div className="flex flex-1 flex-col items-center justify-center gap-5">
            <Donut segments={contactSegments} centerLabel="Total" centerValue={contacts.length} />
            <Legend segments={contactSegments} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Lead Status" />
          <div className="flex flex-col gap-5 pt-2">
            <StatRow label="Closed" value={closedLeads} total={leads.length} color="var(--green)" />
            <StatRow label="Follow-up Required" value={followupLeads} total={leads.length} color="var(--red)" />
            <div className="rounded-xl border border-[var(--border)] p-4 text-center">
              <p className="text-3xl font-bold text-green">
                {leads.length ? Math.round((closedLeads / leads.length) * 100) : 0}%
              </p>
              <p className="mt-1 text-xs text-faint">Lead conversion rate</p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Meeting Performance" />
          <div className="flex flex-col gap-4 pt-2">
            <div className="grid grid-cols-2 gap-3">
              <MiniStat label="Show Rate" value={showRate} tone="var(--green)" />
              <MiniStat label="Scheduled" value={String(meetings.length)} tone="var(--accent)" />
            </div>
            <StatRow label="Online" value={online} total={meetings.length} color="var(--accent)" />
            <StatRow label="In-Person" value={inPerson} total={meetings.length} color="var(--purple)" />
          </div>
        </Card>
      </div>

      {/* Top deals */}
      <Card className="mt-5">
        <CardHeader title="Top Deals" icon={<Trophy className="h-[18px] w-[18px] text-amber" />} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-faint">
                <th className="pb-3 font-medium">Deal</th>
                <th className="pb-3 font-medium">Contact</th>
                <th className="pb-3 font-medium">Stage</th>
                <th className="pb-3 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {topDeals.map((d) => {
                const stage = STAGES.find((s) => s.id === d.stage);
                return (
                  <tr key={d.id} className="border-t border-[var(--border)] text-sm">
                    <td className="py-3 pr-3 font-medium">{d.title}</td>
                    <td className="py-3 pr-3">
                      <span className="flex items-center gap-2">
                        <Avatar initials={d.initials} color={d.color} size="sm" />
                        <span className="text-muted">{d.contact}</span>
                      </span>
                    </td>
                    <td className="py-3 pr-3">
                      <span
                        className="rounded-md px-2 py-0.5 text-xs font-semibold"
                        style={{ background: stage?.soft, color: stage?.color }}
                      >
                        {stage?.label}
                      </span>
                    </td>
                    <td className="py-3 text-right font-bold text-green">{compactMoney(d.value)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Charts ---------------- */

function Donut({
  segments,
  centerLabel,
  centerValue,
  size = 168,
  thickness = 24,
}: {
  segments: { label: string; value: number; color: string }[];
  centerLabel: string;
  centerValue: number;
  size?: number;
  thickness?: number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;

  // Each arc's offset is the total length of the segments before it.
  const arcs = segments.map((seg, i) => ({
    ...seg,
    dash: (seg.value / total) * c,
    offset: segments.slice(0, i).reduce((sum, s) => sum + (s.value / total) * c, 0),
  }));

  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={thickness} />
          {arcs.map((arc, i) => (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={arc.color}
              strokeWidth={thickness}
              strokeDasharray={`${arc.dash} ${c - arc.dash}`}
              strokeDashoffset={-arc.offset}
            />
          ))}
        </g>
      </svg>
      <div className="absolute text-center leading-tight">
        <p className="text-2xl font-bold tabular-nums">{centerValue}</p>
        <p className="text-[11px] text-faint">{centerLabel}</p>
      </div>
    </div>
  );
}

function Legend({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      {segments.map((s) => (
        <div key={s.label} className="flex items-center gap-2.5 text-sm">
          <span className="h-3 w-3 rounded-sm" style={{ background: s.color }} />
          <span className="text-muted">{s.label}</span>
          <span className="ml-auto font-semibold tabular-nums">{s.value}</span>
        </div>
      ))}
    </div>
  );
}

function StatRow({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-sm">
        <span className="text-muted">{label}</span>
        <span className="font-semibold">
          {value} <span className="text-xs text-faint">({pct}%)</span>
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] p-3 text-center">
      <p className="text-2xl font-bold" style={{ color: tone }}>
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-faint">{label}</p>
    </div>
  );
}
