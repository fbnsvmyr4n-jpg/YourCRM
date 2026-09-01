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
  Video,
  X,
} from "lucide-react";
import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { PersonField, addressablePeople, type Person } from "@/components/ui/PersonField";
import { clsx } from "@/lib/clsx";
import { SortMenu } from "@/components/ui/SortMenu";
import { shortDate } from "@/components/meetings/WorkloadCapacity";
import { useTextDraft } from "@/lib/use-draft";
import { SuggestInput } from "@/components/ui/SuggestInput";
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
  today,
  people,
}: {
  meetings: UpcomingMeeting[];
  analytics: MeetingAnalytics;
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
        {/*
            LEFT dashboard, on a screen wide enough to have two columns.

            Every threshold in this subtree is a PAGE-width one. The wrapper
            deliberately does not declare its own container: when it did, these
            rows measured themselves against the left COLUMN, which at a 1440px
            window is 774px — under 820 — so all three cards vanished on the
            desktop while the page around them was plainly wide enough. 976 and
            916 are the old 620 and 560 column thresholds expressed against the
            page, which is the same box the two-column split is decided in.

            `display: contents` below that, so these cards stop being a block
            that has to sit somewhere and become direct children of the page
            grid — which is what lets the scheduler be ordered above them
            without moving anything on the desktop. Its own container query only
            applies where the box exists to be measured; below 820px the rows
            are single-column regardless, because the page itself is.
        */}
        <div className="contents @min-[820px]:flex @min-[820px]:flex-col @min-[820px]:gap-5">
          {/*
              Off the phone entirely.

              "Meetings" counted the same meetings Workload & Capacity is
              already about, and its online/in-person split now sits there
              instead. Pipeline Conversion and Loss Insights are reporting, and
              Reports already carries both — the funnel with its show rate and
              conversion, and "Why deals were lost". Nothing is lost by taking
              them off this page; what is gained is that booking a meeting is
              the first thing on it rather than the fourth.
          */}
          <div className="hidden gap-5 @min-[820px]:grid @min-[820px]:grid-cols-1 @min-[976px]:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
            <MeetingsBreakdown analytics={analytics} meetings={meetings} />
            <PipelineConversion analytics={analytics} />
          </div>
          <div className="hidden @min-[820px]:block">
            <LossInsights analytics={analytics} meetings={meetings} />
          </div>
        </div>

        {/* RIGHT scheduler rail — and the FIRST thing on a phone, because
            booking is why anyone opens this page. */}
        <Scheduler
          className="order-first @min-[820px]:order-none"
          today={today}
          people={people}
          meetings={meetings}
        />
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
    <Card className="@container">
      {/* The heading gets its own line, and the controls wrap under it. Packed
          onto one row at 393px the tabs, the sort and "View Calendar" ran off
          the right of the card — the last control read "View Cale". */}
      <div className="mb-4 flex flex-col gap-3 @min-[680px]:flex-row @min-[680px]:items-center @min-[680px]:justify-between">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <Calendar className="h-[18px] w-[18px] text-accent" /> Upcoming Meetings
        </h3>
        {/*
            Laid out, not wrapped.

            These are four tabs, a sort and a link, and `flex-wrap` let the
            available width decide where the breaks fell. At 393px the four tabs
            measured 257px of text in a 311px box — they fit by a single pixel
            locally and did not on a real iPhone, where the same labels render
            slightly wider. The result was three ragged rows: three tabs, then
            "This Week" beside the sort, then the link on its own.

            A four-column grid puts every tab in an equal share of the row
            whatever the font does, and the sort and the link take the line
            below. Two tidy rows at any width, instead of one to three depending
            on how the text happened to measure.
        */}
        <div className="flex flex-col gap-2 @min-[680px]:flex-row @min-[680px]:items-center @min-[680px]:gap-1">
          {/* Two columns before four. Measured: four tabs fit without clipping
              down to a 278px card, and at 238px — a 320px phone — "Tomorrow"
              and "This Week" both lost their ends. A truncated tab is worse
              than a second row, so the narrowest phones get 2x2 and everything
              from a modern handset upward gets the single row. */}
          <div className="grid grid-cols-2 gap-1 @min-[270px]:grid-cols-4 @min-[680px]:flex @min-[680px]:items-center">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={clsx(
                  "focus-ring truncate rounded-full px-1.5 py-1.5 text-[11px] font-medium transition-colors @min-[680px]:px-3 @min-[680px]:py-1 @min-[680px]:text-xs",
                  tab === t ? "text-accent" : "text-muted hover:text-[var(--text)]"
                )}
                style={tab === t ? { background: "var(--accent-soft)" } : undefined}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 @min-[680px]:gap-1">
            <SortMenu options={MEETING_SORTS} value={sort} onChange={setSort} defaultId="soonest" />
            {/* Fills the rest of its row on a phone, so the two controls read as
                one line rather than a button and a gap. */}
            <Link
              href="/calendar"
              className="btn-soft focus-ring flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-medium @min-[680px]:flex-none @min-[680px]:py-1.5"
            >
              <Calendar className="h-3.5 w-3.5" /> View Calendar
            </Link>
          </div>
        </div>
      </div>

      {/* A seven-column table needs 680px and the phone has 353. It used to
          scroll sideways inside the card, which hides most of every row behind
          a gesture nobody is told about — the reader saw Time and half of the
          contact name. Below 680px each meeting is a card instead, carrying the
          same facts stacked. */}
      <div className="hidden @min-[680px]:-m-1 @min-[680px]:block @min-[680px]:scroll-p-2 @min-[680px]:overflow-x-auto @min-[680px]:p-1">
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
      </div>

      <div className="flex flex-col gap-2.5 @min-[680px]:hidden">
        {rows.map((m) => (
          <MeetingCard
            key={m.id}
            m={m}
            busy={busyId === m.id}
            onEdit={() => setEditing(m)}
            onDelete={() => handleDelete(m.id, m.name)}
          />
        ))}
      </div>

      {rows.length === 0 && <p className="py-6 text-center text-sm text-faint">Nothing scheduled.</p>}

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

/**
 * One upcoming meeting, on a phone.
 *
 * The table this replaces needs 680px for its seven columns and scrolled
 * sideways inside a 353px card, so the reader saw Time and half a name and had
 * to discover a horizontal gesture to reach the rest. The same facts stack
 * here: when it is, who with, what about, and what came of it.
 *
 * Reschedule is the button rather than a pencil, because rebooking is what
 * actually happens to a meeting in this list — someone cannot make it and the
 * time moves. It opens the same editor the desktop pencil does.
 */
function MeetingCard({
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
    <div className="rounded-2xl border border-[var(--border)] p-3">
      <div className="flex items-start gap-3">
        <Avatar initials={m.initials} color={m.color} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm font-semibold">{m.name}</p>
            {/* Nowrap and shrink-0: the time is the one thing on this card that
                must never be the part that gets truncated. */}
            <span className="shrink-0 whitespace-nowrap text-xs font-medium tabular-nums text-muted">
              {toDisplayTime(m.time)}
            </span>
          </div>
          {(m.company || m.topic) && (
            <p className="truncate text-xs text-muted">
              {[m.company, m.topic].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span
          className="rounded-md px-2 py-0.5 text-[10px] font-semibold"
          style={{
            background: m.when === "Today" ? "var(--accent-soft)" : "var(--amber-soft)",
            color: m.when === "Today" ? "var(--accent)" : "var(--amber)",
          }}
        >
          {m.when}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-muted">
          {m.type === "Online" ? (
            <Video className="h-3.5 w-3.5 text-accent" />
          ) : (
            <UserRound className="h-3.5 w-3.5 text-purple" />
          )}
          {m.type}
        </span>
        <select
          value={outcome}
          disabled={saving || busy}
          onChange={(e) => change(e.target.value)}
          aria-label={`Outcome for the meeting with ${m.name}`}
          className="focus-ring ml-auto cursor-pointer rounded-md border-0 px-2 py-1 text-[11px] font-semibold outline-none disabled:opacity-50"
          style={{ background: tone.bg, color: tone.fg }}
        >
          {MEETING_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABELS[o]}
            </option>
          ))}
        </select>
      </div>

      {outcome === "lost" && m.lossReason && (
        <p className="mt-1 text-[10px] text-faint">{m.lossReason}</p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={onEdit}
          disabled={busy}
          className="btn-soft focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold disabled:opacity-40"
        >
          <Pencil className="h-3.5 w-3.5" /> Reschedule
        </button>
        {/* Only a real stored link becomes a Join button — otherwise it would
            look actionable and do nothing. */}
        {m.link && (
          <a
            href={m.link}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-accent focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Join
          </a>
        )}
        <button
          onClick={onDelete}
          disabled={busy}
          aria-label={`Delete the meeting with ${m.name}`}
          className="focus-ring grid h-9 w-9 shrink-0 place-items-center rounded-xl text-faint transition-colors hover:text-[var(--red)] disabled:opacity-40"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
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

function Scheduler({
  today,
  people,
  meetings,
  className,
}: {
  today: DayRef;
  people: Person[];
  meetings: UpcomingMeeting[];
  className?: string;
}) {
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
  /**
   * What this account has actually used before.
   *
   * Read from the meetings already on the page — no new query, and nothing
   * invented: an account with no history offers nothing rather than examples
   * somebody might take for real records. Newest first, because the useful
   * answer to "what do I put here" is almost always the last one.
   */
  const history = useMemo(() => {
    const byNewest = [...meetings].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    return {
      topics: byNewest.map((m) => m.topic).filter((t): t is string => Boolean(t && t.trim())),
      links: byNewest.map((m) => m.link).filter((l): l is string => Boolean(l && l.trim())),
      /* Only addresses that could receive a change notice. */
      emails: addressablePeople(people).map((pp) => pp.email),
      /* Who was met most recently, offered before anything is typed. */
      recent: byNewest
        .map((m) => people.find((pp) => pp.name === m.name))
        .filter((pp): pp is Person => Boolean(pp)),
    };
  }, [meetings, people]);

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
    <div ref={panelRef} className={clsx("flex flex-col gap-4", className)}>
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
      <Card className="@container !p-4">
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
            recent={history.recent}
          />
          <SuggestInput
            value={topic}
            onChange={setTopic}
            options={history.topics}
            placeholder="Meeting topic (optional)"
            ariaLabel="Meeting topic"
          />
          <SuggestInput
            value={email}
            onChange={setEmail}
            options={history.emails}
            type="email"
            placeholder="Participant email (for change notices)"
            ariaLabel="Participant email"
          />
          {online && (
            <SuggestInput
              value={link}
              onChange={setLink}
              options={history.links}
              type="url"
              placeholder="Meeting link (opened from the table)"
              ariaLabel="Meeting link"
            />
          )}
        </div>

        {/* The time column stacks under the calendar until there is room for
            both. Measured at 393px with them side by side: 169px left for seven
            day columns, so each cell was 23.9px and they sat edge to edge with
            no gap at all. Full width the calendar gets 321px, which is a day
            cell you can actually hit. */}
        <div className="grid grid-cols-1 gap-3 @min-[420px]:grid-cols-[minmax(0,1fr)_140px]">
          {/* calendar */}
          <div>
            {/* A three-track grid, not `justify-between`. Between two 28px
                buttons the label was mathematically centred and still touched
                both of them — measured 0px of clearance either side, because
                "September 2026" filled every pixel it was given. The middle
                track centres the label in whatever is left, and the padding
                keeps it off the arrows however long the month name is. */}
            <div className="mb-2 grid grid-cols-[28px_minmax(0,1fr)_28px] items-center">
              <button onClick={() => shiftMonth(-1)} className="btn-soft focus-ring grid h-7 w-7 place-items-center rounded-lg" aria-label="Previous month">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="truncate px-2 text-center text-sm font-medium">
                {MONTH_NAMES[view.month]} {view.year}
              </span>
              <button onClick={() => shiftMonth(1)} className="btn-soft focus-ring grid h-7 w-7 place-items-center rounded-lg" aria-label="Next month">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-x-1 gap-y-1 text-center text-[11px] text-faint">
              {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                <span key={i}>{d}</span>
              ))}
            </div>
            {/* `gap-x` as well as `gap-y`. Without it the cells filled their
                tracks completely and every number sat flush against the next,
                which reads as overlapping even where the boxes only touch. */}
            <div className="mt-1 grid grid-cols-7 gap-x-1 gap-y-1 text-center text-xs">
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
                      "focus-ring mx-auto grid aspect-square w-full max-w-9 place-items-center rounded-lg transition-colors",
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
      <div className="modal-surface relative z-10 w-full max-w-md p-6">
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
  /**
   * Typed-but-unsaved notes outlive the box they were typed in.
   *
   * This component is keyed on the meeting, so picking another one from the
   * dropdown unmounts it — and whatever had been typed went with it, silently.
   * A reload lost it too. Nothing warned, and a warning would be the wrong
   * answer: the work should simply still be there.
   *
   * Keyed per meeting, so one meeting's notes can never surface against
   * another, and only stored while it differs from what the server holds.
   */
  const {
    value: notes,
    setValue: setNotes,
    clear,
  } = useTextDraft(`yourcrm:meeting-notes:${meeting.id}`, meeting.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const dirty = notes !== (meeting.notes ?? "");

  async function save() {
    setSaving(true);
    try {
      const fd = new FormData();
      fd.set("notes", notes);
      await setMeetingNotesAction(meeting.id, fd);
      /* The draft has served its purpose the moment the server has the text.
         Left behind it would shadow the saved copy forever, including any edit
         made from another device. */
      clear();
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
