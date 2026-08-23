"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { useOpenFromQuery } from "@/lib/useOpenFromQuery";
import {
  Calendar,
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  HelpCircle,
  Pencil,
  Info,
  Trash2,
  TrendingUp,
  UserRound,
  Users,
  Video,
  X,
} from "lucide-react";
import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { PersonField, type Person } from "@/components/ui/PersonField";
import { clsx } from "@/lib/clsx";
import { SortMenu } from "@/components/ui/SortMenu";
import { minutesOfDay, parseTime, toDisplayTime } from "@/lib/time";
import {
  LOSS_REASONS,
  MEETING_OUTCOMES,
  OUTCOME_LABELS,
  type MeetingOutcome,
  type MeetingType,
  type UpcomingMeeting,
} from "@/data/meetings";
import type { MeetingAnalytics } from "@/server/meeting-analytics";
import {
  addMeetingAction,
  deleteMeetingAction,
  setMeetingNotesAction,
  setMeetingOutcomeAction,
  updateMeetingAction,
  type NotifyResult,
} from "./actions";

export type DayRef = { year: number; month: number; day: number };

export type { Person };

/** A rate nobody has earned data for reads as "—", never as an unearned 0%. */
function rate(v: number | null) {
  return v === null ? "—" : `${v}%`;
}

export default function MeetingsView({
  meetings,
  analytics,
  capacity,
  today,
  people,
}: {
  meetings: UpcomingMeeting[];
  analytics: MeetingAnalytics;
  /** Weekly meeting capacity, configured in Settings. */
  capacity: number;
  today: DayRef;
  /** Contacts and leads, for the scheduler's autocomplete. */
  people: Person[];
}) {
  return (
    <div className="mx-auto max-w-[1500px] animate-fade-up">
      {/* Header — every figure counted from recorded outcomes */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-5 pt-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Meeting Dashboard</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            {analytics.total} Meeting{analytics.total === 1 ? "" : "s"}
            <Dot />
            <span className="text-green">{rate(analytics.showRate)}</span> Show Rate
            <Dot />
            <span className="text-purple">{rate(analytics.conversion)}</span> Conversion
            {analytics.pending > 0 && (
              <>
                <Dot />
                <span className="text-faint">{analytics.pending} awaiting outcome</span>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 @min-[820px]:grid-cols-[minmax(0,1fr)_336px]">
        {/* LEFT dashboard. Its own container: what these two rows can fit depends
            on whether the 336px side column is sitting next to them, not on how
            wide the window is. */}
        <div className="@container flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-5 @min-[620px]:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
            <MeetingsBreakdown analytics={analytics} meetings={meetings} />
            <PipelineConversion analytics={analytics} />
          </div>
          <div className="grid grid-cols-1 gap-5 @min-[560px]:grid-cols-2">
            <LossInsights analytics={analytics} meetings={meetings} />
            <WorkloadCapacity analytics={analytics} capacity={capacity} meetings={meetings} />
          </div>
        </div>

        {/* RIGHT scheduler rail */}
        <Scheduler today={today} people={people} meetings={meetings} />
      </div>

      {/* The table runs the full width, below the rail rather than beside it.
          Inside the left column it was 764px for seven columns — 63 cells wrapped
          onto a second line — while 659px of empty rail sat next to it, because
          the grid stretches the rail to match whichever column is taller. Out
          here it gets the whole page and the rail only has to match the analytics
          cards above it. */}
      <div className="mt-5">
        <UpcomingTable meetings={meetings} people={people} />
      </div>
    </div>
  );
}

function Dot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-[var(--purple)]" />;
}

/* ---------------- Meetings breakdown ---------------- */

/**
 * Replaces the old "Meetings This Week" card, which showed a hardcoded
 * seven-day histogram and a "20% vs last week" that was never computed.
 * Meetings are grouped by Today/Tomorrow/This Week rather than carrying a real
 * date, so a per-weekday chart isn't something the data can support — this
 * shows the outcome mix instead, which it can.
 */
function MeetingsBreakdown({
  analytics,
  meetings,
}: {
  analytics: MeetingAnalytics;
  meetings: UpcomingMeeting[];
}) {
  // Soonest first. `when` is already recomputed from the stored date on read,
  // so anything past reads as "Today" and stays visible rather than vanishing.
  const next = [...meetings]
    .filter((m) => m.date)
    .sort((a, b) => (a.date! + toDisplayTime(a.time)).localeCompare(b.date! + toDisplayTime(b.time)))
    .slice(0, 5);

  const rows: { label: string; value: number; color: string }[] = [
    { label: "Closed won", value: analytics.won, color: "var(--green)" },
    { label: "Advanced", value: analytics.advanced - analytics.won, color: "var(--purple)" },
    { label: "Lost", value: analytics.lost, color: "var(--red)" },
    { label: "No-show", value: analytics.noShow, color: "var(--amber)" },
    { label: "Awaiting outcome", value: analytics.pending, color: "var(--border-strong)" },
  ].filter((r) => r.value > 0);

  return (
    <Card className="flex flex-col">
      <div className="mb-4 flex items-center gap-2">
        <CalendarCheck className="h-[18px] w-[18px] text-accent" />
        <h3 className="text-[15px] font-semibold tracking-tight">Meetings</h3>
      </div>

      <div>
        <p className="text-xs text-faint">Total scheduled</p>
        <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums">{analytics.total}</p>
        <p className="mt-1 text-xs text-faint">
          {analytics.decided} with a recorded outcome
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-faint">No meetings scheduled yet.</p>
      ) : (
        <div className="mt-5 space-y-2.5">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-3">
              <span className="w-32 shrink-0 truncate text-xs text-muted">{r.label}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(r.value / analytics.total) * 100}%`, background: r.color }}
                />
              </div>
              <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums">{r.value}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 border-t border-[var(--border)] pt-4">
        <div>
          <p className="text-[11px] text-faint">Online</p>
          <p className="mt-0.5 text-lg font-bold tabular-nums text-accent">{analytics.byType.online}</p>
        </div>
        <div>
          <p className="text-[11px] text-faint">In-person</p>
          <p className="mt-0.5 text-lg font-bold tabular-nums text-purple">{analytics.byType.inPerson}</p>
        </div>
      </div>

      {/* The panel used to stop here, leaving a tall blank below the two
          counts. What's actually useful in that space is what's coming up
          next — data the page already has. */}
      <div className="mt-5 flex min-h-0 flex-1 flex-col border-t border-[var(--border)] pt-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Next up</p>
        {next.length === 0 ? (
          <p className="text-sm text-faint">Nothing scheduled from today onwards.</p>
        ) : (
          <ul className="space-y-2.5">
            {next.map((m) => (
              <li key={m.id} className="flex items-center gap-2.5">
                <Avatar initials={m.initials} color={m.color} size="sm" />
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="truncate text-xs font-semibold">{m.name}</p>
                  <p className="truncate text-[11px] text-faint" title={m.topic}>{m.topic}</p>
                </div>
                <div className="shrink-0 text-right leading-tight">
                  <p className="text-xs font-semibold tabular-nums">{toDisplayTime(m.time)}</p>
                  <p className="text-[10px] text-faint">{m.when}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/* ---------------- Pipeline Conversion ---------------- */

const FUNNEL_COLORS = ["var(--purple)", "var(--green)", "var(--accent)", "var(--amber)"];

function PipelineConversion({ analytics }: { analytics: MeetingAnalytics }) {
  const { funnel, total, decided, pending, noShow, won } = analytics;

  if (total === 0) {
    return (
      <Card>
        <h3 className="mb-4 flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <TrendingUp className="h-[18px] w-[18px] text-accent" /> Pipeline Conversion
        </h3>
        <p className="py-12 text-center text-sm text-faint">
          Schedule a meeting and record its outcome to see the funnel.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <TrendingUp className="h-[18px] w-[18px] text-accent" /> Pipeline Conversion
        </h3>
        <span className="flex items-center gap-1 text-xs text-faint" title="Counted from the outcome recorded against each meeting.">
          <HelpCircle className="h-3.5 w-3.5" /> From recorded outcomes
        </span>
      </div>

      {/* Two by two, not four across. In the two-column dashboard this card is
          439px wide, which left each of four steps ~95px — under the ~104px
          "Showed Up" needs — so every label ellipsed to "Bo…", "Sh…", "Ad…".
          Two columns give each step ~205px and the labels read in full. The
          numbered badges already carry the order, so the chevrons that used to
          sit between steps were spending width to repeat it. The taller block
          also squares this card off against the Meetings breakdown beside it,
          which was stretching it 132px past its own content. */}
      <div className="grid grid-cols-2 gap-2.5">
        {funnel.map((s, i) => (
          <div key={s.label} className="min-w-0 rounded-2xl border border-[var(--border)] p-3">
            <p className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted">
              <span
                className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white"
                style={{ background: FUNNEL_COLORS[i] }}
              >
                {i + 1}
              </span>
              <span className="truncate">{s.label}</span>
            </p>
            <p className="mt-2 text-2xl font-bold tabular-nums">{s.value}</p>
            <p className="text-[11px] font-semibold" style={{ color: FUNNEL_COLORS[i] }}>
              {s.pct}%
            </p>
            <p className="text-[10px] text-faint">of booked</p>
          </div>
        ))}
      </div>

      <div className="mt-5 space-y-3">
        {funnel.map((b, i) => (
          <div key={b.label} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-xs text-muted">{b.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
              <div className="h-full rounded-full" style={{ width: `${b.pct}%`, background: FUNNEL_COLORS[i] }} />
            </div>
            <span className="w-20 shrink-0 text-right text-xs font-medium tabular-nums">
              {b.value} ({b.pct}%)
            </span>
          </div>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3 border-t border-[var(--border)] pt-4">
        <div>
          <p className="text-[11px] text-faint">No-Show</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-red">
            {noShow}
            {decided > 0 && <span className="text-xs"> ({Math.round((noShow / decided) * 100)}%)</span>}
          </p>
          <p className="text-[10px] text-faint">Of decided meetings</p>
        </div>
        <div>
          <p className="text-[11px] text-faint">Awaiting Outcome</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-amber">{pending}</p>
          <p className="text-[10px] text-faint">Not yet recorded</p>
        </div>
        <div>
          <p className="text-[11px] text-faint">Close Rate</p>
          <p className="mt-1 text-lg font-bold tabular-nums text-green">{rate(analytics.conversion)}</p>
          <p className="text-[10px] text-faint">
            {won} of {decided} decided
          </p>
        </div>
      </div>
    </Card>
  );
}

/* ---------------- Loss Insights ---------------- */

function LossInsights({
  analytics,
  meetings,
}: {
  analytics: MeetingAnalytics;
  meetings: UpcomingMeeting[];
}) {
  const { lossReasons, lossRate, lost, noShow, decided } = analytics;
  const totalLost = lost + noShow;
  const max = Math.max(1, ...lossReasons.map((r) => r.count));

  /**
   * The meetings actually holding this panel back.
   *
   * With nothing marked up there are no loss reasons to draw, and a sentence
   * saying so left the card half empty. These are the records that would fill
   * it — oldest first, because a meeting that happened three weeks ago is the
   * one whose outcome is hardest to remember.
   *
   * "Awaiting" is `outcome === "scheduled"`, not a missing field: the repo's
   * `normalise` defaults every row to "scheduled" on read, so `!m.outcome` is
   * never true and this list silently rendered empty. Same test the analytics
   * uses for `pending`.
   */
  const awaitingAll = meetings
    .filter((m) => m.outcome === "scheduled" && m.date)
    .sort((a, b) => a.date!.localeCompare(b.date!));
  // Seven, so the card lands level with Workload & Capacity beside it and the
  // backlog is mostly visible rather than a token sample. The heading carries
  // the true total so a truncated list can't read as the whole backlog.
  const awaiting = awaitingAll.slice(0, 7);

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <TrendingUp className="h-[18px] w-[18px] rotate-180 text-red" /> Loss Insights
          <Info className="h-3.5 w-3.5 text-faint" />
        </h3>
        {lossRate !== null && (
          <span className="rounded-lg px-2.5 py-1 text-xs font-semibold text-red" style={{ background: "var(--red-soft)" }}>
            {lossRate}% Loss Rate
          </span>
        )}
      </div>
      <p className="mb-4 text-xs text-faint">
        {totalLost === 0
          ? decided === 0
            ? "No outcomes recorded yet."
            : "Nothing lost yet — every decided meeting advanced."
          : `${totalLost} of ${decided} decided opportunities were lost`}
      </p>

      {lossReasons.length === 0 ? (
        <>
          <p className="text-sm text-faint">
            Mark a meeting as Lost or No-show to see why deals fall through.
          </p>
          {awaiting.length > 0 && (
            <div className="mt-5 border-t border-[var(--border)] pt-4">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                  Oldest without an outcome
                </p>
                <span className="shrink-0 text-[11px] tabular-nums text-faint">
                  {awaiting.length === awaitingAll.length
                    ? awaitingAll.length
                    : `${awaiting.length} of ${awaitingAll.length}`}
                </span>
              </div>
              <div className="flex flex-col">
                {awaiting.map((m) => (
                  <div key={m.id} className="flex items-center gap-2.5 py-1.5">
                    <Avatar initials={m.initials} color={m.color} size="sm" />
                    <div className="min-w-0 flex-1 leading-tight">
                      <p className="truncate text-xs font-medium">{m.name}</p>
                      <p className="truncate text-[11px] text-faint" title={m.topic}>{m.topic}</p>
                    </div>
                    <span className="shrink-0 text-[11px] text-faint">{shortDate(m.date)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-2.5">
          {lossReasons.map((r) => (
            <div key={r.label} className="flex items-center gap-3">
              <span className="w-32 shrink-0 truncate text-xs text-muted">{r.label}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                <div className="h-full rounded-full" style={{ width: `${(r.count / max) * 100}%`, background: "var(--red)" }} />
              </div>
              <span className="w-14 shrink-0 text-right text-xs font-medium tabular-nums">
                {r.count} ({r.pct}%)
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------------- Workload & Capacity ---------------- */

/** "Mon 11 Aug" from a stored `YYYY-MM-DD`, parsed as UTC so it can't slip a day. */
function shortDate(iso?: string) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "—";
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function WorkloadCapacity({
  analytics,
  capacity,
  meetings,
}: {
  analytics: MeetingAnalytics;
  capacity: number;
  meetings: UpcomingMeeting[];
}) {
  const { total, pending, decided, won } = analytics;

  /**
   * How the load actually falls across days.
   *
   * "9 of 20 scheduled" says the week is comfortable; it does not say three of
   * them are on one afternoon. Built from the days that genuinely have meetings
   * rather than a fixed window, so the strip is never a row of empty bars.
   */
  const perDay = (() => {
    const counts = new Map<string, number>();
    for (const m of meetings) {
      if (m.date) counts.set(m.date, (counts.get(m.date) ?? 0) + 1);
    }
    const rows = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return rows.slice(-5).map(([date, count]) => ({ date, count }));
  })();
  const busiest = Math.max(1, ...perDay.map((d) => d.count));
  const usedPct = Math.min(100, Math.round((total / capacity) * 100));
  const load = usedPct >= 90 ? "At Capacity" : usedPct >= 60 ? "Busy" : "Good Load";
  const loadColor = usedPct >= 90 ? "var(--red)" : usedPct >= 60 ? "var(--amber)" : "var(--green)";
  const loadSoft = usedPct >= 90 ? "var(--red-soft)" : usedPct >= 60 ? "var(--amber-soft)" : "var(--green-soft)";

  // Ordered as the work actually happens: booked → still to mark up → marked
  // up → won. The previous order put Decided before Awaiting, which reads
  // backwards against the sequence it describes.
  const stats = [
    { label: "Scheduled", value: total, sub: "Total booked", color: "var(--purple)" },
    { label: "Awaiting", value: pending, sub: "Needs marking up", color: "var(--amber)" },
    { label: "Decided", value: decided, sub: "Outcome recorded", color: "var(--accent)" },
    { label: "Closed won", value: won, sub: "From meetings", color: "var(--green)" },
  ];

  return (
    <Card className="card-q">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <Users className="h-[18px] w-[18px] text-accent" /> Workload &amp; Capacity
        </h3>
        <span
          className="rounded-lg px-2.5 py-1 text-xs font-semibold"
          style={{ background: loadSoft, color: loadColor }}
        >
          {load}
        </span>
      </div>

      <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
        <div className="h-full rounded-full accent-gradient" style={{ width: `${usedPct}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-xs text-faint">
        <span>
          {total} of {capacity} meetings scheduled
        </span>
        <span className="tabular-nums">{usedPct}%</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 @min-[520px]:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-[var(--border)] p-3 text-center">
            <p className="text-lg font-bold tabular-nums" style={{ color: s.color }}>
              {s.value}
            </p>
            <p className="mt-0.5 text-[11px] font-medium">{s.label}</p>
            <p className="text-[10px] text-faint">{s.sub}</p>
          </div>
        ))}
      </div>

      {perDay.length > 0 && (
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              Load by day
            </p>
            <p className="text-[11px] text-faint">
              Busiest: {busiest} meeting{busiest === 1 ? "" : "s"}
            </p>
          </div>
          <div className="space-y-2">
            {perDay.map((d) => (
              <div key={d.date} className="flex items-center gap-3">
                <span className="w-24 shrink-0 truncate text-[11px] text-muted">
                  {shortDate(d.date)}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                  <div
                    className="accent-gradient h-full rounded-full"
                    style={{ width: `${(d.count / busiest) * 100}%` }}
                  />
                </div>
                <span className="w-4 shrink-0 text-right text-[11px] font-semibold tabular-nums">
                  {d.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/* ---------------- Upcoming Meetings table ---------------- */

const TABS = ["All", "Today", "Tomorrow", "This Week"] as const;

/**
 * How the meeting list can be ordered.
 *
 * Soonest first is the default and is what a schedule means — the next thing
 * you have to do is the next row. The others are for looking back: "outcome"
 * groups the no-shows together, which is the fastest way to see a pattern.
 */
const MEETING_SORTS = [
  { id: "soonest", label: "Soonest first" },
  { id: "latest", label: "Latest first" },
  { id: "name", label: "Name (A–Z)" },
  { id: "outcome", label: "Outcome" },
] as const;
type MeetingSort = (typeof MEETING_SORTS)[number]["id"];

function UpcomingTable({
  meetings,
  people,
}: {
  meetings: UpcomingMeeting[];
  people: Person[];
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("All");
  const [sort, setSort] = useState<MeetingSort>("soonest");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<UpcomingMeeting | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rows = useMemo(() => {
    const byTab = meetings.filter((m) => tab === "All" || m.when === tab);
    const byDate = (a: UpcomingMeeting, b: UpcomingMeeting) =>
      (a.date ?? "").localeCompare(b.date ?? "") || minutesOfDay(a.time) - minutesOfDay(b.time);

    // Copied before sorting: `sort` mutates, and this array comes from props.
    const out = [...byTab];
    switch (sort) {
      case "name":
        return out.sort((a, b) => a.name.localeCompare(b.name) || byDate(a, b));
      case "outcome":
        // Grouped by what happened, then soonest first inside each group.
        // `outcome` is optional on the record — an unrecorded meeting sorts
        // with the others rather than throwing, and stays in date order.
        return out.sort(
          (a, b) => (a.outcome ?? "").localeCompare(b.outcome ?? "") || byDate(a, b)
        );
      case "latest":
        return out.sort((a, b) => byDate(b, a));
      case "soonest":
      default:
        return out.sort(byDate);
    }
  }, [meetings, tab, sort]);

  /**
   * Say exactly what happened to the notification.
   *
   * "Participants notified" when no mail provider is configured would be the
   * phantom-lead bug again — a confident claim about something that did not
   * occur. The action reports whether a message really went out and this
   * repeats it verbatim.
   */
  function report(result: { notified?: { sent: boolean; to?: string; reason?: string } } | undefined, done: string) {
    const n = result?.notified;
    if (n?.sent) setNotice(`${done} — ${n.to} was notified.`);
    else setNotice(`${done} — no email sent (${n?.reason ?? "unknown reason"}).`);
    setTimeout(() => setNotice(null), 6000);
  }

  async function handleDelete(id: string, name: string) {
    if (
      !confirm(
        `Delete the meeting with ${name}? They'll be told it's cancelled if they have an email ` +
          `on file. You can put the meeting back from Settings → Recently deleted, but that ` +
          `cancellation has already gone.`
      )
    )
      return;
    setBusyId(id);
    try {
      const res = await deleteMeetingAction(id);
      report(res, "Meeting cancelled");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <Calendar className="h-[18px] w-[18px] text-accent" /> Upcoming Meetings
        </h3>
        <div className="flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                "focus-ring rounded-full px-3 py-1 text-xs font-medium transition-colors",
                tab === t ? "text-accent" : "text-muted hover:text-[var(--text)]"
              )}
              style={tab === t ? { background: "var(--accent-soft)" } : undefined}
            >
              {t}
            </button>
          ))}
          <span className="ml-1">
            <SortMenu options={MEETING_SORTS} value={sort} onChange={setSort} defaultId="soonest" />
          </span>
          <Link
            href="/calendar"
            className="btn-soft focus-ring ml-1 flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-medium"
          >
            <Calendar className="h-3.5 w-3.5" /> View Calendar
          </Link>
        </div>
      </div>

      <div className="-m-1 scroll-p-2 overflow-x-auto p-1">
        <table className="w-full min-w-[680px] border-collapse">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-faint">
              <th className="pb-3 font-medium">Time</th>
              <th className="pb-3 font-medium">Client / Contact</th>
              <th className="pb-3 font-medium">Company</th>
              <th className="pb-3 font-medium">Meeting Topic</th>
              <th className="pb-3 font-medium">Type</th>
              <th className="pb-3 font-medium">Outcome</th>
              <th className="pb-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <MeetingRow
                key={m.id}
                m={m}
                busy={busyId === m.id}
                onEdit={() => setEditing(m)}
                onDelete={() => handleDelete(m.id, m.name)}
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="py-6 text-center text-sm text-faint">Nothing scheduled.</p>}
      </div>

      {notice && (
        <p className="mt-3 rounded-xl px-3 py-2 text-xs" style={{ background: "var(--raise)" }}>
          {notice}
        </p>
      )}

      {editing && (
        <EditMeetingModal
          meeting={editing}
          people={people}
          onClose={() => setEditing(null)}
          onSaved={(res) => {
            report(res, "Meeting updated");
            setEditing(null);
          }}
        />
      )}
    </Card>
  );
}

const OUTCOME_COLORS: Record<MeetingOutcome, { fg: string; bg: string }> = {
  scheduled: { fg: "var(--amber)", bg: "var(--amber-soft)" },
  "no-show": { fg: "var(--red)", bg: "var(--red-soft)" },
  showed: { fg: "var(--accent)", bg: "var(--accent-soft)" },
  advanced: { fg: "var(--purple)", bg: "var(--purple-soft)" },
  won: { fg: "var(--green)", bg: "var(--green-soft)" },
  lost: { fg: "var(--red)", bg: "var(--red-soft)" },
};

function MeetingRow({
  m,
  busy,
  onEdit,
  onDelete,
}: {
  m: UpcomingMeeting;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const outcome: MeetingOutcome = m.outcome ?? "scheduled";
  const tone = OUTCOME_COLORS[outcome];
  const [saving, setSaving] = useState(false);

  async function change(next: string) {
    if (next === outcome) return;
    setSaving(true);
    try {
      // A loss needs a reason to be useful in the breakdown; ask for one
      // rather than silently filing every loss under "Other".
      let reason: string | undefined;
      if (next === "lost") {
        const picked = prompt(
          `Why was this lost?\n\n${LOSS_REASONS.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n\nEnter a number:`,
          "4"
        );
        const idx = Number(picked) - 1;
        reason = LOSS_REASONS[idx] ?? "Other";
      }
      await setMeetingOutcomeAction(m.id, next, reason);
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-t border-[var(--border)] text-sm">
      <td className="py-3 pr-3 whitespace-nowrap">
        <span
          className="mr-2 rounded-md px-2 py-0.5 text-[10px] font-semibold"
          style={{
            background: m.when === "Today" ? "var(--accent-soft)" : "var(--amber-soft)",
            color: m.when === "Today" ? "var(--accent)" : "var(--amber)",
          }}
        >
          {m.when}
        </span>
        <span className="font-medium tabular-nums">{toDisplayTime(m.time)}</span>
      </td>
      {/* Clicking a meeting opens where it happens. Only a real stored link
          becomes a link — otherwise the row says there isn't one rather than
          looking clickable and doing nothing. */}
      <td className="py-3 pr-3">
        {m.link ? (
          <a
            href={m.link}
            target="_blank"
            rel="noopener noreferrer"
            title={`Join: ${m.link}`}
            className="focus-ring group flex items-center gap-2"
          >
            <Avatar initials={m.initials} color={m.color} size="sm" />
            <span className="font-medium text-accent group-hover:underline">{m.name}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-faint" />
          </a>
        ) : (
          <span className="flex items-center gap-2" title="No meeting link saved — add one with Edit">
            <Avatar initials={m.initials} color={m.color} size="sm" />
            <span className="font-medium">{m.name}</span>
          </span>
        )}
      </td>
      <td className="py-3 pr-3 text-muted">{m.company}</td>
      <td className="py-3 pr-3 text-muted">{m.topic}</td>
      <td className="py-3 pr-3">
        <span className="flex items-center gap-1.5 text-muted">
          {m.type === "Online" ? (
            <Video className="h-4 w-4 text-accent" />
          ) : (
            <UserRound className="h-4 w-4 text-purple" />
          )}
          {m.type}
        </span>
      </td>
      <td className="py-3 pr-3">
        <select
          value={outcome}
          disabled={saving || busy}
          onChange={(e) => change(e.target.value)}
          aria-label={`Outcome for the meeting with ${m.name}`}
          className="focus-ring cursor-pointer rounded-md border-0 px-2 py-1 text-xs font-semibold outline-none disabled:opacity-50"
          style={{ background: tone.bg, color: tone.fg }}
        >
          {MEETING_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABELS[o]}
            </option>
          ))}
        </select>
        {outcome === "lost" && m.lossReason && (
          <p className="mt-1 text-[10px] text-faint">{m.lossReason}</p>
        )}
      </td>
      <td className="py-3 text-right">
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={onEdit}
            disabled={busy}
            className="focus-ring text-faint transition-colors hover:text-accent disabled:opacity-40"
            aria-label={`Edit the meeting with ${m.name}`}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="focus-ring text-faint transition-colors hover:text-[var(--red)] disabled:opacity-40"
            aria-label={`Delete the meeting with ${m.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

/* ---------------- Scheduler rail ---------------- */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The picked day as `YYYY-MM-DD`. Replaces the old `computeWhen`, which turned
 * the date into a "Today"/"Tomorrow" label right here and threw the date away —
 * so the label could never correct itself once the day rolled over.
 */
function dateKey(sel: DayRef): string {
  const m = String(sel.month + 1).padStart(2, "0");
  const d = String(sel.day).padStart(2, "0");
  return `${sel.year}-${m}-${d}`;
}

function Scheduler({ today, people, meetings }: { today: DayRef; people: Person[]; meetings: UpcomingMeeting[] }) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Arriving from the dashboard Quick Action: bring the scheduler into view
  // and ring it, so it is obvious which panel the user was sent to.
  useOpenFromQuery(
    "schedule",
    useCallback(() => {
      const el = panelRef.current;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("jump-target");
      window.setTimeout(() => el.classList.remove("jump-target"), 2800);
    }, [])
  );

  const [online, setOnline] = useState(true);
  const [connected, setConnected] = useState(true);
  const [view, setView] = useState({ year: today.year, month: today.month });
  const [selected, setSelected] = useState<DayRef>(today);
  const [slot, setSlot] = useState("10:30");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [justAdded, setJustAdded] = useState(false);

  const cells = monthGrid(view.year, view.month);
  const selDate = new Date(selected.year, selected.month, selected.day);
  const selLabel = `${WEEKDAY_FULL[selDate.getDay()]}, ${selected.day} ${MONTH_NAMES[selected.month].slice(0, 3)}`;

  const shiftMonth = (dir: number) => {
    let m = view.month + dir;
    let y = view.year;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setView({ year: y, month: m });
  };

  async function confirmMeeting() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("name", name);
      fd.set("company", company);
      fd.set("email", email);
      fd.set("link", link);
      fd.set("topic", topic);
      fd.set("time", slot);
      // Send the real date the user picked. The Today/Tomorrow label is
      // derived from it server-side on every read, so it can't go stale.
      fd.set("date", dateKey(selected));
      fd.set("type", online ? "Online" : "In-Person");
      await addMeetingAction(fd);
      setName("");
      setCompany("");
      setEmail("");
      setLink("");
      setTopic("");
      setJustAdded(true);
      setTimeout(() => setJustAdded(false), 2500);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={panelRef} className="flex flex-col gap-4">
      {/* connect calendar */}
      <Card className="!p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Connect your Calendar</span>
          {/* `.switch` rather than utilities — see the note in globals.css. */}
          <button
            type="button"
            role="switch"
            aria-checked={connected}
            onClick={() => setConnected((v) => !v)}
            className="switch focus-ring"
            aria-label="Toggle calendar connection"
          >
            <span className="switch-knob" />
          </button>
        </div>
        <div className="mt-3 flex rounded-xl border border-[var(--border)] p-1">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              onClick={() => setOnline(v)}
              className={clsx(
                "focus-ring flex-1 rounded-lg py-1.5 text-sm font-medium transition-colors",
                online === v ? "text-accent" : "text-faint"
              )}
              style={online === v ? { background: "var(--accent-soft)" } : undefined}
            >
              {v ? "Online meeting" : "In-Person"}
            </button>
          ))}
        </div>
      </Card>

      {/* schedule a meeting */}
      <Card className="!p-4">
        <p className="mb-3 text-sm font-semibold">Schedule a Meeting</p>

        {/* contact + topic */}
        <div className="mb-3 space-y-2">
          <PersonField
            value={name}
            onChange={setName}
            onPick={(p) => {
              setName(p.name);
              if (p.company && p.company !== "—") setCompany(p.company);
              if (p.email) setEmail(p.email);
            }}
            people={people}
          />
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Meeting topic (optional)"
            className="field-input"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="Participant email (for change notices)"
            className="field-input"
          />
          {online && (
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="Meeting link (opened from the table)"
              className="field-input"
            />
          )}
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_140px] gap-3">
          {/* calendar */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <button onClick={() => shiftMonth(-1)} className="btn-soft focus-ring grid h-7 w-7 place-items-center rounded-lg" aria-label="Previous month">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-medium">
                {MONTH_NAMES[view.month]} {view.year}
              </span>
              <button onClick={() => shiftMonth(1)} className="btn-soft focus-ring grid h-7 w-7 place-items-center rounded-lg" aria-label="Next month">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-y-1 text-center text-[11px] text-faint">
              {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                <span key={i}>{d}</span>
              ))}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-y-1 text-center text-xs">
              {cells.map((c, i) => {
                const isSel =
                  c.inMonth &&
                  c.day === selected.day &&
                  view.month === selected.month &&
                  view.year === selected.year;
                return (
                  <button
                    key={i}
                    onClick={() => c.inMonth && setSelected({ year: view.year, month: view.month, day: c.day })}
                    className={clsx(
                      // Sized by its track, not fixed. `w-7` was 28px in a
                      // column only 21.4px wide, so every day overlapped the
                      // next one by ~7px and the last column spilled past the
                      // card. Filling the cell can't outgrow it.
                      "focus-ring mx-auto grid aspect-square w-full max-w-7 place-items-center rounded-lg transition-colors",
                      !c.inMonth && "text-faint opacity-50",
                      isSel ? "font-semibold text-white" : c.inMonth ? "hover:bg-[var(--raise)]" : ""
                    )}
                    style={isSel ? { background: "var(--accent)" } : undefined}
                  >
                    {c.day}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Time. Was a fixed list of half-hour slots in 12-hour format, so
              a 14:20 meeting simply couldn't be booked. */}
          <div className="flex flex-col">
            <p className="mb-1.5 text-center text-[11px] font-medium text-muted">{selLabel}</p>
            <TimePicker value={slot} onChange={setSlot} />
            <p className="mt-1 text-center text-[10px] text-faint">24-hour</p>
          </div>
        </div>

        <button
          onClick={confirmMeeting}
          disabled={busy || !name.trim()}
          className="btn-accent focus-ring mt-4 w-full rounded-xl py-2.5 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? "Scheduling…" : justAdded ? "✓ Meeting Scheduled" : "Confirm Meeting"}
        </button>
        {justAdded && (
          <p className="mt-2 text-center text-xs text-green">Added to Upcoming Meetings.</p>
        )}
      </Card>

      {/* Meeting notes — last in the rail, so it takes the slack.
          The grid stretches this rail to match the analytics column beside it,
          which left 140px of empty card-less space under here. `flex-1` hands
          that leftover to this card and the column layout passes it down to the
          textarea, so the gap turns into somewhere to actually write rather
          than into padding. Where the rail isn't stretched (under 820px the
          grid is a single column) there is no slack to take and the textarea
          falls back to its min-height, which is the size it has always been. */}
      <Card className="!p-4 flex flex-1 flex-col">
        <MeetingNotes meetings={meetings} />
      </Card>
    </div>
  );
}

/** Build a 6x7 Monday-first month grid with leading/trailing days. */
function monthGrid(year: number, month: number) {
  const first = new Date(year, month, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysPrev = new Date(year, month, 0).getDate();
  const cells: { day: number; inMonth: boolean }[] = [];
  for (let i = 0; i < startDow; i++) {
    cells.push({ day: daysPrev - startDow + 1 + i, inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, inMonth: true });
  let next = 1;
  while (cells.length < 42) cells.push({ day: next++, inMonth: false });
  return cells.slice(0, 42);
}

/* ---------------- Shared inputs ---------------- */

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
// Every minute, not five-minute steps: a scrollable column can carry all sixty
// without the length becoming a problem, and a 09:47 call is a real thing.
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

/**
 * One scrollable column of numbers.
 *
 * Keeps the current value centred when it changes from outside — opening the
 * edit modal on a 16:45 meeting should show 16 and 45 without the user hunting
 * for them. Scrolls the column itself rather than using `scrollIntoView`, which
 * would drag the whole page along with it.
 */
function TimeColumn({
  values,
  selected,
  onSelect,
  label,
}: {
  values: string[];
  selected: string;
  onSelect: (v: string) => void;
  label: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    const item = activeRef.current;
    if (!box || !item) return;
    box.scrollTop = item.offsetTop - box.clientHeight / 2 + item.clientHeight / 2;
  }, [selected]);

  return (
    <div className="min-w-0 flex-1">
      <p className="mb-1 text-center text-[10px] font-medium uppercase tracking-wide text-faint">{label}</p>
      <div
        ref={boxRef}
        role="listbox"
        aria-label={label}
        // `relative` matters: `offsetTop` below is measured against the
        // nearest *positioned* ancestor, so without it the centring maths runs
        // against some outer container and lands on the wrong number.
        // Padding matches the 30px fade in `.time-wheel` exactly, so the travel
        // past the first and last value lives *inside* the fade and is never
        // seen as a blank band. It used to be 60px — the amount an iOS wheel
        // needs to bring its end values to the centre — which left 40% of the
        // column empty at either extreme with nothing marking a centre to
        // explain why.
        className="time-wheel relative h-[152px] overflow-y-auto rounded-xl border border-[var(--border)] px-1 py-[30px]"
      >
        {values.map((v) => {
          const active = v === selected;
          return (
            <button
              key={v}
              ref={active ? activeRef : undefined}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => onSelect(v)}
              className={clsx(
                "focus-ring block w-full py-1.5 text-center text-sm tabular-nums transition-colors",
                active ? "font-bold text-accent" : "text-muted hover:text-[var(--text)]"
              )}
              style={active ? { background: "var(--accent-soft)" } : undefined}
            >
              {v}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 24-hour time, with minutes.
 *
 * Scrollable columns rather than dropdowns: the numbers are all visible at
 * once, scrolled through and clicked directly, instead of hidden behind a
 * select that has to be opened first.
 *
 * The old picker offered a fixed list of half-hour slots in 12-hour format, so
 * a 14:20 meeting simply could not be booked. Deliberately not a native
 * `<input type="time">` either — that renders as AM/PM under some locales,
 * which is the thing being fixed.
 */
function TimePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsed = parseTime(value) ?? { hour: 10, minute: 0 };
  const hh = String(parsed.hour).padStart(2, "0");
  const mm = String(parsed.minute).padStart(2, "0");

  return (
    <div>
      <div className="flex items-stretch gap-1.5">
        <TimeColumn label="Hour" values={HOURS} selected={hh} onSelect={(h) => onChange(`${h}:${mm}`)} />
        <TimeColumn label="Min" values={MINUTES} selected={mm} onSelect={(m) => onChange(`${hh}:${m}`)} />
      </div>
      <p className="mt-1.5 text-center text-sm font-semibold tabular-nums">
        {hh}:{mm}
      </p>
    </div>
  );
}

/* ---------------- Edit meeting ---------------- */

function EditMeetingModal({
  meeting,
  people,
  onClose,
  onSaved,
}: {
  meeting: UpcomingMeeting;
  people: Person[];
  onClose: () => void;
  onSaved: (res: { notified?: NotifyResult }) => void;
}) {
  const [name, setName] = useState(meeting.name);
  const [company, setCompany] = useState(meeting.company === "—" ? "" : meeting.company);
  const [email, setEmail] = useState(meeting.email ?? "");
  const [topic, setTopic] = useState(meeting.topic);
  const [date, setDate] = useState(meeting.date ?? "");
  const [time, setTime] = useState(toDisplayTime(meeting.time));
  const [type, setType] = useState<MeetingType>(meeting.type);
  const [link, setLink] = useState(meeting.link ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("name", name);
      fd.set("company", company);
      fd.set("email", email);
      fd.set("topic", topic);
      fd.set("date", date);
      fd.set("time", time);
      fd.set("type", type);
      fd.set("link", link);

      const res = await updateMeetingAction(meeting.id, fd);
      if (res && "error" in res && res.error) {
        setError(res.error);
        return;
      }
      onSaved(res ?? {});
    } finally {
      setBusy(false);
    }
  }

  const label = "mb-1.5 block text-xs font-medium text-muted";

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="modal-surface relative z-10 max-h-[90vh] w-full max-w-md overflow-y-auto p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Edit meeting</h2>
          <button type="button" onClick={onClose} className="text-faint hover:text-[var(--text)]" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <span className={label}>Contact</span>
            <PersonField
              value={name}
              onChange={setName}
              onPick={(p) => {
                setName(p.name);
                if (p.company && p.company !== "—") setCompany(p.company);
                if (p.email) setEmail(p.email);
              }}
              people={people}
            />
          </div>

          <label className="block">
            <span className={label}>Company</span>
            <input value={company} onChange={(e) => setCompany(e.target.value)} className="field-input" />
          </label>

          <label className="block">
            <span className={label}>
              Participant email
              <span className="ml-1 font-normal text-faint">— where change notices go</span>
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              className="field-input"
            />
          </label>

          <label className="block">
            <span className={label}>Topic</span>
            <input value={topic} onChange={(e) => setTopic(e.target.value)} className="field-input" />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={label}>Date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="field-input" />
            </label>
            <div>
              <span className={label}>Time (24h)</span>
              <TimePicker value={time} onChange={setTime} />
            </div>
          </div>

          <div>
            <span className={label}>Format</span>
            <div className="flex rounded-xl border border-[var(--border)] p-1">
              {(["Online", "In-Person"] as MeetingType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={clsx(
                    "focus-ring flex-1 rounded-lg py-1.5 text-sm font-medium transition-colors",
                    type === t ? "text-accent" : "text-faint"
                  )}
                  style={type === t ? { background: "var(--accent-soft)" } : undefined}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className={label}>
              Meeting link
              <span className="ml-1 font-normal text-faint">— opened when the row is clicked</span>
            </span>
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://meet.google.com/…"
              className="field-input"
            />
          </label>
        </div>

        {error && <p className="mt-3 text-xs" style={{ color: "var(--red)" }}>{error}</p>}

        <p className="mt-4 text-[11px] text-faint">
          Saving emails the participant a summary of what changed, if they have an address on file.
        </p>

        <div className="mt-4 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="btn-soft focus-ring rounded-xl px-5 py-2.5 text-sm font-medium">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !name.trim() || !date}
            className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save & notify"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ---------------- Meeting notes ---------------- */

/**
 * Notes, attached to the meeting they describe.
 *
 * The textarea here had no state and no save — anything typed into it was gone
 * on the next render, and it wasn't tied to a meeting either. Notes now belong
 * to a meeting and persist, which is also what lets the assistant read them.
 */
function MeetingNotes({ meetings }: { meetings: UpcomingMeeting[] }) {
  const [id, setId] = useState(meetings[0]?.id ?? "");
  const selected = meetings.find((m) => m.id === id);

  // Keyed on the meeting below, so switching meetings loads that one's notes
  // instead of carrying the previous text across.
  return (
    <>
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
        <p className="text-sm font-semibold">Meeting Notes</p>
        {meetings.length > 0 && (
          <select
            value={id}
            onChange={(e) => setId(e.target.value)}
            aria-label="Meeting these notes belong to"
            className="focus-ring max-w-[150px] truncate rounded-lg border border-[var(--border)] bg-[var(--panel-solid)] px-2 py-1 text-xs outline-none focus:border-[var(--border-strong)]"
          >
            {meetings.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {toDisplayTime(m.time)}
              </option>
            ))}
          </select>
        )}
      </div>

      {selected ? (
        <NotesEditor key={selected.id} meeting={selected} />
      ) : (
        <p className="text-sm text-faint">Schedule a meeting to take notes against it.</p>
      )}
    </>
  );
}

function NotesEditor({ meeting }: { meeting: UpcomingMeeting }) {
  const [notes, setNotes] = useState(meeting.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = notes !== (meeting.notes ?? "");

  async function save() {
    setSaving(true);
    try {
      const fd = new FormData();
      fd.set("notes", notes);
      await setMeetingNotesAction(meeting.id, fd);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* No `rows`: the height comes from the flex column so the field fills the
          card. `min-h` is the floor for when there is no slack to fill — the
          same 112px four rows used to give. */}
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={`Notes for ${meeting.name} — ${meeting.topic}…`}
        className="field-input min-h-[112px] flex-1 resize-y"
      />
      <div className="mt-2 flex shrink-0 items-center justify-between gap-2">
        <span className="text-[11px] text-faint">
          {saved ? "Saved." : dirty ? "Unsaved changes" : "Up to date"}
        </span>
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="btn-soft focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save notes"}
        </button>
      </div>
    </>
  );
}
