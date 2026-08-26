import Link from "next/link";
import { clsx } from "@/lib/clsx";
import {
  Building2,
  CalendarCheck,
  Headset,
  HelpCircle,
  Radar,
  Share2,
  TrendingUp,
  Trophy,
  UserPlus,
  Wallet,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { AreaChart } from "@/components/ui/AreaChart";
import { Card, CardHeader } from "@/components/ui/Card";
import { companyRollups } from "@/server/repos/companies";
import { getSettings } from "@/server/repos/settings";
import { PERIODS, PERIOD_LABELS, isPeriod, resolvePeriod, type PeriodId } from "@/server/report-period";
import { referralCredits } from "@/server/referrals";
import { reportView } from "@/server/reports-view";
import { withTenantPage } from "@/server/tenant-session";
import { ExportButton } from "./ExportButton";

export const dynamic = "force-dynamic";

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

/**
 * A bar's fill, fading slightly to the right.
 *
 * Written as `${color}bb` before, which appends an alpha suffix to the colour
 * string. That is only valid when the colour is a hex literal — with a token
 * like `var(--purple)` it produces `var(--purple)bb`, the whole gradient is
 * invalid, and the bar renders **nothing**. Seven of nine bars on this page
 * were blank because of it, including "Closed Won" at full width. `color-mix`
 * takes the token itself, so it works for every colour in the palette.
 */
const barFill = (color: string) =>
  `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 65%, transparent))`;
/** A rate nobody has data for reads as "—", never as an unearned 0%. */
const rate = (v: number | null) => (v === null ? "—" : `${v}%`);

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  /**
   * The window comes from the URL.
   *
   * So a period can be linked to and survives a refresh — "look at July" is a
   * link somebody can send, rather than a sequence of clicks they have to
   * describe. Checked rather than trusted: the value arrives from a browser.
   */
  const requested = (await searchParams).period ?? "";
  const periodId: PeriodId = isPeriod(requested) ? requested : "all-time";
  // Both in one tenant transaction — a referrer's credit cannot describe deals
  // a different read would not return.
  const { r, referrers, accounts } = await withTenantPage(async (q) => {
    // The business's own time zone, so "July" is July where they are — read in
    // the same transaction as the figures it defines.
    const { timeZone } = await getSettings(q);
    const period = resolvePeriod(periodId, timeZone || "UTC");
    return {
      r: await reportView(q, period),
      referrers: await referralCredits(q),
      accounts: await companyRollups(q),
    };
  });

  const kpis = [
    {
      icon: <Trophy className="h-5 w-5" />,
      label: "Revenue Won",
      value: money(r.revenueWon),
      sub: `${r.wonCount} deal${r.wonCount === 1 ? "" : "s"} · ${r.contacts.clients} client${r.contacts.clients === 1 ? "" : "s"}`,
      tone: "var(--green)",
      soft: "var(--green-soft)",
    },
    {
      icon: <Wallet className="h-5 w-5" />,
      // Deliberately not filtered by the period: there is no such thing as
      // "the open pipeline of July" — those deals have since closed or are
      // still open today. The sub-label says so.
      label: "Open Pipeline",
      value: money(r.openPipeline),
      sub: `${r.openCount} deal${r.openCount === 1 ? "" : "s"} in play${r.period ? " · right now" : ""}`,
      tone: "var(--accent)",
      soft: "var(--accent-soft)",
    },
    {
      icon: <TrendingUp className="h-5 w-5" />,
      label: "Win Rate",
      value: rate(r.winRate),
      sub: `of ${r.wonCount + r.openCount} deal${r.wonCount + r.openCount === 1 ? "" : "s"}`,
      tone: "var(--purple)",
      soft: "var(--purple-soft)",
    },
    {
      icon: <Wallet className="h-5 w-5" />,
      label: "Average Deal",
      value: r.avgDealSize === null ? "—" : money(r.avgDealSize),
      sub: "across every deal",
      tone: "var(--amber)",
      soft: "var(--amber-soft)",
    },
  ];

  // The CSV carries the same rows the page renders — see ExportButton.
  const csv: string[][] = [
    ["YourCRM report", new Date().toISOString().slice(0, 10)],
    [],
    ["Headline", "Value"],
    ["Revenue won", String(r.revenueWon)],
    ["Open pipeline", String(r.openPipeline)],
    ["Deals won", String(r.wonCount)],
    ["Deals open", String(r.openCount)],
    ["Win rate %", r.winRate === null ? "" : String(r.winRate)],
    ["Average deal", r.avgDealSize === null ? "" : String(r.avgDealSize)],
    ["Outstanding on won deals", String(r.outstanding)],
    [],
    ["Pipeline stage", "Deals", "Value"],
    ...r.stages.map((s) => [s.label, String(s.count), String(s.value)]),
    [],
    ["Lead source", "Leads", "Revenue traced"],
    ...r.sources.map((s) => [s.source, String(s.leads), String(s.revenue)]),
    [],
    ["Lead status", "Leads"],
    ...r.leadStatus.map((s) => [s.label, String(s.count)]),
    [],
    ["Week ending", "Revenue won"],
    ...r.weekly.map((w) => [w.label, String(w.value)]),
    [],
    ["Voice agent", "Value"],
    ["Calls answered", String(r.voice.calls)],
    ["Calls that became a lead", String(r.voice.producedLead)],
    ["Calls that booked a meeting", String(r.voice.bookedMeeting)],
    ["Minutes answered", String(r.voice.totalMinutes)],
    ...r.voice.byOutcome.map((o) => [o.label, String(o.count)]),
  ];

  const maxStage = Math.max(1, ...r.stages.map((s) => s.value));
  const maxSourceLeads = Math.max(1, ...r.sources.map((s) => s.leads));
  const totalLeads = r.sources.reduce((sum, s) => sum + s.leads, 0);
  /**
   * Won revenue split by source.
   *
   * There is no untraced remainder any more. Source used to be discovered by
   * matching a won deal to a lead BY NAME, and only 4 of 10 matched — so this
   * chart carried a grey "No lead record" wedge for the money it could not
   * explain. Source is a column on the deal now, so every pound is accounted
   * for and the wedge has nothing to hold.
   */
  const revenueSegments = r.sources
    .filter((s) => s.revenue > 0)
    .map((s) => ({ label: s.source, value: s.revenue, color: s.color }));

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-up">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-5 pt-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Reports &amp; Analytics</h1>
          <p className="mt-1 text-sm text-muted">
            Every figure below is counted from your own records — deals, leads and meetings. Nothing
            is estimated.
          </p>

          {/**
            * Period links, not a dropdown.
            *
            * Each is a real URL, so a period can be linked to and survives a
            * refresh — "look at July" becomes something to send rather than a
            * sequence of clicks to describe.
            */}
          <div className="tab-row mt-3 flex flex-wrap items-center gap-1">
            {PERIODS.map((id) => (
              <Link
                key={id}
                href={id === "all-time" ? "/reports" : `/reports?period=${id}`}
                scroll={false}
                className={clsx(
                  "focus-ring rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  periodId === id ? "text-accent" : "text-muted hover:text-[var(--text)]"
                )}
                style={periodId === id ? { background: "var(--accent-soft)" } : undefined}
              >
                {PERIOD_LABELS[id]}
              </Link>
            ))}
          </div>

          {r.period?.previousLabel && (
            /* What changed, in words as well as a number. A rise from nothing
               is not "+100%" — it is a first sale, and saying so is the honest
               version of a figure that would otherwise read as infinite. */
            <p className="mt-2 text-xs text-faint">
              {r.period.revenueChange === null
                ? r.revenueWon > 0
                  ? `Nothing won in ${r.period.previousLabel}, so there is nothing to compare against.`
                  : `Nothing won in this period or ${r.period.previousLabel}.`
                : `${r.period.revenueChange >= 0 ? "Up" : "Down"} ${Math.abs(r.period.revenueChange)}% on ${r.period.previousLabel} (${money(r.period.previousRevenue ?? 0)}).`}
            </p>
          )}
        </div>
        <ExportButton rows={csv} filename={`yourcrm-report-${new Date().toISOString().slice(0, 10)}.csv`} />
      </div>

      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-4 @min-[880px]:grid-cols-4">
        {kpis.map((k) => (
          <div
            key={k.label}
            className="card p-5"
            style={{ background: `linear-gradient(135deg, ${k.soft}, transparent 85%)` }}
          >
            <span
              className="grid h-11 w-11 place-items-center rounded-xl"
              style={{ background: k.soft, color: k.tone }}
            >
              {k.icon}
            </span>
            <p className="mt-4 text-2xl font-bold tabular-nums sm:text-3xl">{k.value}</p>
            <p className="mt-1 text-sm font-medium">{k.label}</p>
            <p className="text-xs text-faint">{k.sub}</p>
          </div>
        ))}
      </div>

      {/* Revenue over time + pipeline */}
      <div className="mt-5 grid grid-cols-1 gap-5 @min-[880px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="Revenue won"
            icon={<TrendingUp className="h-[18px] w-[18px] text-accent" />}
            action={<span className="text-xs text-faint">Last 6 weeks</span>}
          />
          <p className="text-3xl font-bold tracking-tight tabular-nums">
            {money(r.weekly.reduce((sum, w) => sum + w.value, 0))}
          </p>
          <p className="mt-1 text-xs text-faint">
            Banked in this window. Each deal counts on the day it was actually marked won.
          </p>
          <div className="mt-2">
            <AreaChart data={r.weekly} height={220} />
          </div>
        </Card>

        <Card className="flex flex-col">
          <CardHeader
            title="Pipeline by stage"
            icon={<Wallet className="h-[18px] w-[18px] text-accent" />}
          />
          {/* This card is the shorter of the pair, so the grid stretches it to
              match the revenue chart and left 27px hanging under the last stage.
              Spreading the five rows over the extra height reads as deliberate
              spacing rather than a gap at the bottom. */}
          <div className="flex flex-1 flex-col justify-between gap-4 pt-1">
            {r.stages.map((s) => (
              <div key={s.id}>
                <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                    <span className="truncate font-medium">{s.label}</span>
                    <span className="shrink-0 text-xs text-faint">({s.count})</span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{money(s.value)}</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-[var(--border)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(s.value / maxStage) * 100}%`,
                      background: barFill(s.color),
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Four panels in two stacked columns, paired so the columns finish
          level. A short card beside a tall one leaves a void beneath it —
          padding a card with filler would only hide that, so the panels are
          paired by height instead: leads + voice on the left, status +
          meetings on the right. Measured, the two columns end within ~10px
          of each other. */}
      <div className="mt-5 grid grid-cols-1 gap-5 @min-[880px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader
              title="Where leads come from"
              icon={<Radar className="h-[18px] w-[18px] text-accent" />}
              action={<span className="text-xs text-faint">{totalLeads} leads</span>}
            />
            {totalLeads === 0 ? (
              <p className="py-6 text-sm text-faint">No leads captured yet.</p>
            ) : (
              <div className="space-y-4 pt-1">
                {r.sources.map((s) => (
                  <div key={s.source}>
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                        <span className="truncate font-medium">{s.source}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">
                        <span className="font-semibold">{s.leads}</span>
                        <span className="ml-2 text-xs text-faint">
                          {s.revenue > 0 ? `${money(s.revenue)} traced` : "no revenue traced"}
                        </span>
                      </span>
                    </div>
                    <div className="h-3 w-full overflow-hidden rounded-full bg-[var(--border)]">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(s.leads / maxSourceLeads) * 100}%`,
                          background: barFill(s.color),
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* The prose said most of the revenue could not be traced; this shows
                it. A stacked bar of won revenue makes the size of the untraced
                share obvious at a glance, which is the entire point of the
                caveat — and it fills a panel that was 104px shorter than its
                neighbour. */}
            {r.wonCount > 0 && (
              <div className="mt-6 border-t border-[var(--border)] pt-4">
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                    Won revenue by source
                  </p>
                  <p className="text-xs text-faint">{money(r.revenueWon)} total</p>
                </div>

                <div className="flex h-3 w-full overflow-hidden rounded-full bg-[var(--border)]">
                  {revenueSegments.map((seg) => (
                    <div
                      key={seg.label}
                      title={`${seg.label} — ${money(seg.value)}`}
                      style={{ width: `${(seg.value / r.revenueWon) * 100}%`, background: seg.color }}
                    />
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
                  {revenueSegments.map((seg) => (
                    <span key={seg.label} className="flex items-center gap-1.5 text-xs">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: seg.color }} />
                      <span className="text-muted">{seg.label}</span>
                      <span className="font-semibold tabular-nums">{money(seg.value)}</span>
                    </span>
                  ))}
                </div>

                <p className="mt-3 flex items-start gap-2 text-xs text-faint">
                  <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Every deal records where it came from, so all won revenue is attributed. This
                    used to be matched by name and only some of it could be traced.
                  </span>
                </p>
              </div>
            )}
          </Card>

          <Card className="flex flex-1 flex-col">
            <CardHeader
              title="Voice agent"
              icon={<Headset className="h-[18px] w-[18px] text-accent" />}
              action={
                <Link href="/voice-agents" className="focus-ring rounded text-xs font-semibold text-accent hover:underline">
                  Open console
                </Link>
              }
            />
            {r.voice.calls === 0 ? (
              <p className="py-6 text-sm text-faint">No calls answered yet.</p>
            ) : (
              <div className="flex flex-1 flex-col">
                <div className="grid grid-cols-3 gap-3 pt-1">
                  <div className="rounded-xl border border-[var(--border)] p-3">
                    <p className="text-[11px] text-faint">Calls</p>
                    <p className="mt-0.5 text-xl font-bold tabular-nums">{r.voice.calls}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--border)] p-3">
                    <p className="text-[11px] text-faint">Became a lead</p>
                    <p className="mt-0.5 text-xl font-bold tabular-nums text-accent">
                      {r.voice.producedLead}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--border)] p-3">
                    <p className="text-[11px] text-faint">Booked a meeting</p>
                    <p className="mt-0.5 text-xl font-bold tabular-nums text-green">
                      {r.voice.bookedMeeting}
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-2.5">
                  {r.voice.byOutcome.map((o) => (
                    <div key={o.label} className="flex items-center gap-3">
                      <span className="w-32 shrink-0 truncate text-xs text-muted">{o.label}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${(o.count / r.voice.calls) * 100}%`, background: o.color }}
                        />
                      </div>
                      <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums">
                        {o.count}
                      </span>
                    </div>
                  ))}
                </div>

                <p className="mt-auto border-t border-[var(--border)] pt-4 text-xs text-faint">
                  {r.voice.totalMinutes} minute{r.voice.totalMinutes === 1 ? "" : "s"} answered in
                  total
                  {r.voice.avgSeconds !== null && (
                    <> — {Math.floor(r.voice.avgSeconds / 60)}m {r.voice.avgSeconds % 60}s per call on average</>
                  )}
                  .
                </p>
              </div>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader
              title="Lead status"
              icon={<UserPlus className="h-[18px] w-[18px] text-accent" />}
            />
            {r.leadStatus.length === 0 ? (
              <p className="py-6 text-sm text-faint">No leads captured yet.</p>
            ) : (
              <div className="space-y-3 pt-1">
                {r.leadStatus.map((s) => (
                  <div key={s.label} className="flex items-center gap-3">
                    <span className="w-36 shrink-0 truncate text-xs text-muted">{s.label}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${(s.count / totalLeads) * 100}%`, background: s.color }}
                      />
                    </div>
                    <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums">
                      {s.count}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* "Contacts marked lead" used to sit here beside "Clients", which put
                two different meanings of the word lead on one card — a contact's
                type is not a lead record. Replaced with the two things this panel
                is actually about: how many leads convert, and who is waiting. */}
            <div className="mt-5 border-t border-[var(--border)] pt-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[11px] text-faint">Reach Closed Won</p>
                <p className="text-lg font-bold tabular-nums text-green">{rate(r.leadConversion)}</p>
              </div>
              <p className="mt-1 text-xs text-faint">
                {r.leadStatus.find((s) => s.label === "Closed Won")?.count ?? 0} of {totalLeads} leads
                captured.
              </p>
            </div>

            {r.followUps.length > 0 && (
              <div className="mt-5 border-t border-[var(--border)] pt-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                    Waiting on you
                  </p>
                  <Link
                    href="/leads"
                    className="focus-ring rounded text-xs font-semibold text-accent hover:underline"
                  >
                    View all
                  </Link>
                </div>
                {/* No `-mx-1` here: these rows have no hover state to need a
                    gutter, and the negative margin pushed them 4px wider than the
                    rule directly above them. */}
                <div className="flex flex-col">
                  {r.followUps.map((l) => (
                    <div key={l.id} className="flex items-center gap-2.5 rounded-lg py-1.5">
                      <Avatar initials={l.initials} color={l.color} size="sm" />
                      <div className="min-w-0 flex-1 leading-tight">
                        <p className="truncate text-xs font-medium">{l.name}</p>
                        <p className="truncate text-[11px] text-faint">
                          {l.company && l.company !== "—" ? l.company : l.source}
                        </p>
                      </div>
                      <span className="shrink-0 text-[11px] text-faint">{l.source}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <Card className="flex flex-1 flex-col">
            <CardHeader
              title="Meeting outcomes"
              icon={<CalendarCheck className="h-[18px] w-[18px] text-accent" />}
              action={<span className="text-xs text-faint">{r.meetings.total} booked</span>}
            />
            {r.meetings.decided === 0 ? (
              <div className="flex flex-1 flex-col pt-2">
                <p className="text-sm text-faint">
                  No outcomes recorded yet
                  {r.meetings.pending > 0 && <> — {r.meetings.pending} meeting{r.meetings.pending === 1 ? "" : "s"} awaiting one</>}.
                </p>
                {/* Splitting the backlog is the difference between a number and a
                    task list: only the meetings that have already happened are
                    actually waiting on anyone. */}
                {r.meetings.pending > 0 && (
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-[var(--border)] p-3">
                      <p className="text-[11px] text-faint">Already happened</p>
                      <p className="mt-0.5 text-xl font-bold tabular-nums text-amber">
                        {r.awaiting.past}
                      </p>
                      <p className="text-[10px] text-faint">Waiting on you</p>
                    </div>
                    <div className="rounded-xl border border-[var(--border)] p-3">
                      <p className="text-[11px] text-faint">Still to come</p>
                      <p className="mt-0.5 text-xl font-bold tabular-nums">{r.awaiting.upcoming}</p>
                      <p className="text-[10px] text-faint">Not due yet</p>
                    </div>
                  </div>
                )}
                <p className="mt-4 text-xs text-faint">
                  Mark a meeting as showed, advanced, won, lost or no-show and the rates appear here.
                </p>
                <Link
                  href="/meetings"
                  className="focus-ring mt-auto inline-block rounded-lg pt-4 text-sm font-semibold text-accent hover:underline"
                >
                  Go to Meetings →
                </Link>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="rounded-xl border border-[var(--border)] p-3">
                    <p className="text-[11px] text-faint">Show rate</p>
                    <p className="mt-0.5 text-xl font-bold tabular-nums text-green">
                      {rate(r.meetings.showRate)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--border)] p-3">
                    <p className="text-[11px] text-faint">Conversion</p>
                    <p className="mt-0.5 text-xl font-bold tabular-nums text-purple">
                      {rate(r.meetings.conversion)}
                    </p>
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  {r.meetings.funnel.map((f) => (
                    <div key={f.label} className="flex items-center gap-3">
                      <span className="w-28 shrink-0 truncate text-xs text-muted">{f.label}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                        <div
                          className="h-full rounded-full bg-[var(--accent)]"
                          style={{ width: `${f.pct}%` }}
                        />
                      </div>
                      <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums">
                        {f.value}
                      </span>
                    </div>
                  ))}
                </div>
                {r.meetings.lossReasons.length > 0 && (
                  <div className="mt-5 border-t border-[var(--border)] pt-4">
                    <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                      Why deals were lost
                    </p>
                    <div className="space-y-2.5">
                      {r.meetings.lossReasons.map((l) => (
                        <div key={l.label} className="flex items-center gap-3">
                          <span className="w-28 shrink-0 truncate text-xs text-muted">{l.label}</span>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                            <div
                              className="h-full rounded-full bg-[var(--red)]"
                              style={{ width: `${l.pct}%` }}
                            />
                          </div>
                          <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums">
                            {l.count}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {r.meetings.pending > 0 && (
                  <p className="mt-4 text-xs text-faint">
                    {r.meetings.pending} meeting{r.meetings.pending === 1 ? "" : "s"} still awaiting an
                    outcome — these rates are out of the {r.meetings.decided} that have one.
                  </p>
                )}
              </>
            )}
          </Card>
        </div>
      </div>

      {/* Full width: a seven-row list has nothing to sit beside. */}
      <div className="mt-5">
          <Card>
            <CardHeader
              title="Largest deals"
              icon={<Trophy className="h-[18px] w-[18px] text-accent" />}
              action={
                <Link href="/deals" className="focus-ring rounded text-xs font-semibold text-accent hover:underline">
                  View all
                </Link>
              }
            />
            {r.topDeals.length === 0 ? (
              <p className="py-6 text-sm text-faint">No deals yet.</p>
            ) : (
              <div className="-mx-1 flex flex-col">
                {r.topDeals.map((d) => {
                  const stage = r.stages.find((s) => s.id === d.stage);
                  return (
                    <div
                      key={d.id}
                      className="flex items-center gap-3 rounded-xl px-1 py-3 transition-colors hover:bg-[var(--raise)]"
                    >
                      <Avatar
                        initials={
                          d.contact
                            .split(/\s+/)
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((p) => p[0])
                            .join("")
                            .toUpperCase() || "—"
                        }
                        color="blue"
                        size="sm"
                      />
                      <div className="min-w-0 flex-1 leading-tight">
                        <p className="truncate text-sm font-medium">{d.contact}</p>
                        <p className="truncate text-xs text-faint">{d.title}</p>
                      </div>
                      <span
                        className="shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-semibold"
                        style={{ color: stage?.color, background: "var(--raise)" }}
                      >
                        {stage?.label ?? d.stage}
                      </span>
                      <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums">
                        {money(d.value)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {r.outstanding > 0 && (
              <p className="mt-4 border-t border-[var(--border)] pt-4 text-xs text-muted">
                <span className="font-semibold text-amber">{money(r.outstanding)}</span> is recorded as
                still owed on part-paid deals.
              </p>
            )}
          </Card>
      </div>
      {/* Only rendered when there is more than one owner to compare. */}
      {accounts.length > 0 && (
        <div className="mt-5">
          <Card>
            <CardHeader
              title="By company"
              icon={<Building2 className="h-[18px] w-[18px] text-accent" />}
            />
            {/* The question that could not be asked while the company was a
                string on each contact: what is this company worth to us across
                everyone who works there. Deals reach a company through the
                person they belong to. */}
            <div className="space-y-3 pt-1">
              {accounts.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-3">
                  <span className="w-40 shrink-0 truncate text-sm font-medium">{a.name}</span>
                  <span className="flex-1 text-xs text-faint tabular-nums">
                    {a.contacts} {a.contacts === 1 ? "person" : "people"}
                    {a.openDeals > 0 &&
                      ` · ${a.openDeals} open worth ${money(a.openCents / 100)}`}
                  </span>
                  <span
                    className="shrink-0 text-sm font-semibold tabular-nums"
                    style={{ color: a.wonCents > 0 ? "var(--green)" : "var(--muted)" }}
                  >
                    {money(a.wonCents / 100)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {referrers.length > 0 && (
        <div className="mt-5">
          <Card>
            <CardHeader
              title="Who sends you work"
              icon={<Share2 className="h-[18px] w-[18px] text-accent" />}
            />
            {/* Counted from the foreign key on each referred deal, so it cannot
                drift from the deals it describes. Won and open are kept apart:
                a referrer who sent five that went nowhere is not the same as
                one who sent two that closed, and a blended number would hide
                the difference exactly when it is being used to decide who gets
                thanked. */}
            <div className="space-y-3 pt-1">
              {referrers.map((p) => (
                <div key={p.contactId} className="flex flex-wrap items-center gap-3">
                  <span className="w-40 shrink-0 truncate text-sm font-medium">{p.name}</span>
                  <span className="flex-1 text-xs text-faint tabular-nums">
                    {p.referrals} referred · {p.won} won
                    {p.openCents > 0 && ` · ${money(p.openCents / 100)} still open`}
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums" style={{ color: "var(--green)" }}>
                    {money(p.wonCents / 100)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {r.owners.length > 0 && (
        <div className="mt-5">
          <Card>
            <CardHeader
              title="Revenue by owner"
              icon={<Trophy className="h-[18px] w-[18px] text-accent" />}
            />
            <div className="space-y-3 pt-1">
              {r.owners.map((o) => (
                <div key={o.owner} className="flex items-center gap-3">
                  <span className="w-40 shrink-0 truncate text-sm font-medium">{o.owner}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                    <div
                      className="h-full rounded-full bg-[var(--green)]"
                      style={{ width: `${(o.revenue / Math.max(1, r.owners[0].revenue)) * 100}%` }}
                    />
                  </div>
                  <span className="w-12 shrink-0 text-right text-xs text-faint tabular-nums">
                    {o.won} won
                  </span>
                  <span className="w-24 shrink-0 text-right text-sm font-semibold tabular-nums">
                    {money(o.revenue)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
