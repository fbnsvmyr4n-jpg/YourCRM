"use client";

import { useState } from "react";
import {
  Calendar,
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  HelpCircle,
  Info,
  Search,
  Trash2,
  TrendingUp,
  UserRound,
  Users,
  Video,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { clsx } from "@/lib/clsx";
import {
  LOSS_REASONS,
  MEETING_OUTCOMES,
  OUTCOME_LABELS,
  timeSlots,
  type MeetingOutcome,
  type UpcomingMeeting,
} from "@/data/meetings";
import type { MeetingAnalytics } from "@/server/meetings-repo";
import { addMeetingAction, deleteMeetingAction, setMeetingOutcomeAction } from "./actions";

export type DayRef = { year: number; month: number; day: number };

/** A rate nobody has earned data for reads as "—", never as an unearned 0%. */
function rate(v: number | null) {
  return v === null ? "—" : `${v}%`;
}

export default function MeetingsView({
  meetings,
  analytics,
  capacity,
  today,
}: {
  meetings: UpcomingMeeting[];
  analytics: MeetingAnalytics;
  /** Weekly meeting capacity, configured in Settings. */
  capacity: number;
  today: DayRef;
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

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_336px]">
        {/* LEFT dashboard */}
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[0.82fr_1.18fr]">
            <MeetingsBreakdown analytics={analytics} />
            <PipelineConversion analytics={analytics} />
          </div>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <LossInsights analytics={analytics} />
            <WorkloadCapacity analytics={analytics} capacity={capacity} />
          </div>
          <UpcomingTable meetings={meetings} />
        </div>

        {/* RIGHT scheduler rail */}
        <Scheduler today={today} />
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
function MeetingsBreakdown({ analytics }: { analytics: MeetingAnalytics }) {
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

      <div className="flex items-stretch gap-1.5">
        {funnel.map((s, i) => (
          <div key={s.label} className="flex flex-1 items-center gap-1.5">
            <div className="flex-1 rounded-2xl border border-[var(--border)] p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
                <span
                  className="grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold text-white"
                  style={{ background: FUNNEL_COLORS[i] }}
                >
                  {i + 1}
                </span>
                {s.label}
              </p>
              <p className="mt-2 text-2xl font-bold tabular-nums">{s.value}</p>
              <p className="text-[11px] font-semibold" style={{ color: FUNNEL_COLORS[i] }}>
                {s.pct}%
              </p>
              <p className="text-[10px] text-faint">of booked</p>
            </div>
            {i < funnel.length - 1 && <ChevronRight className="h-4 w-4 shrink-0 text-faint" />}
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

function LossInsights({ analytics }: { analytics: MeetingAnalytics }) {
  const { lossReasons, lossRate, lost, noShow, decided } = analytics;
  const totalLost = lost + noShow;
  const max = Math.max(1, ...lossReasons.map((r) => r.count));

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
        <p className="py-8 text-center text-sm text-faint">
          Mark a meeting as Lost or No-show to see why deals fall through.
        </p>
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

function WorkloadCapacity({
  analytics,
  capacity,
}: {
  analytics: MeetingAnalytics;
  capacity: number;
}) {
  const { total, pending, decided, won } = analytics;
  const usedPct = Math.min(100, Math.round((total / capacity) * 100));
  const load = usedPct >= 90 ? "At Capacity" : usedPct >= 60 ? "Busy" : "Good Load";
  const loadColor = usedPct >= 90 ? "var(--red)" : usedPct >= 60 ? "var(--amber)" : "var(--green)";
  const loadSoft = usedPct >= 90 ? "var(--red-soft)" : usedPct >= 60 ? "var(--amber-soft)" : "var(--green-soft)";

  const stats = [
    { label: "Scheduled", value: total, sub: "Total", color: "var(--purple)" },
    { label: "Decided", value: decided, sub: "Outcome recorded", color: "var(--green)" },
    { label: "Awaiting", value: pending, sub: "Needs marking up", color: "var(--amber)" },
    { label: "Closed won", value: won, sub: "From meetings", color: "var(--accent)" },
  ];

  return (
    <Card>
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

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
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
    </Card>
  );
}

/* ---------------- Upcoming Meetings table ---------------- */

const TABS = ["All", "Today", "Tomorrow", "This Week"] as const;

function UpcomingTable({ meetings }: { meetings: UpcomingMeeting[] }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("All");
  const [busyId, setBusyId] = useState<string | null>(null);
  const rows = meetings.filter((m) => tab === "All" || m.when === tab);

  async function handleDelete(id: string) {
    if (!confirm("Delete this meeting?")) return;
    setBusyId(id);
    try {
      await deleteMeetingAction(id);
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
          <button className="btn-soft focus-ring ml-2 flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-medium">
            <Calendar className="h-3.5 w-3.5" /> View Calendar
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
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
              <MeetingRow key={m.id} m={m} busy={busyId === m.id} onDelete={() => handleDelete(m.id)} />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="py-6 text-center text-sm text-faint">Nothing scheduled.</p>}
      </div>
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

function MeetingRow({ m, busy, onDelete }: { m: UpcomingMeeting; busy: boolean; onDelete: () => void }) {
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
        <span className="font-medium">{m.time}</span>
      </td>
      <td className="py-3 pr-3">
        <span className="flex items-center gap-2">
          <Avatar initials={m.initials} color={m.color} size="sm" />
          <span className="font-medium">{m.name}</span>
        </span>
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
        <button
          onClick={onDelete}
          disabled={busy}
          className="focus-ring text-faint transition-colors hover:text-[var(--red)] disabled:opacity-40"
          aria-label="Delete meeting"
        >
          <Trash2 className="h-4 w-4" />
        </button>
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

function Scheduler({ today }: { today: DayRef }) {
  const [online, setOnline] = useState(true);
  const [connected, setConnected] = useState(true);
  const [view, setView] = useState({ year: today.year, month: today.month });
  const [selected, setSelected] = useState<DayRef>(today);
  const [slot, setSlot] = useState("10:30 AM");
  const [name, setName] = useState("");
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
      fd.set("topic", topic);
      fd.set("time", slot);
      // Send the real date the user picked. The Today/Tomorrow label is
      // derived from it server-side on every read, so it can't go stale.
      fd.set("date", dateKey(selected));
      fd.set("type", online ? "Online" : "In-Person");
      await addMeetingAction(fd);
      setName("");
      setTopic("");
      setJustAdded(true);
      setTimeout(() => setJustAdded(false), 2500);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* connect calendar */}
      <Card className="!p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Connect your Calendar</span>
          <button
            onClick={() => setConnected((v) => !v)}
            className={clsx(
              "relative h-6 w-11 rounded-full transition-colors",
              connected ? "accent-gradient" : "bg-[var(--border)]"
            )}
            aria-label="Toggle calendar connection"
          >
            <span
              className={clsx(
                "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform",
                connected ? "translate-x-[22px]" : "translate-x-0.5"
              )}
            />
          </button>
        </div>
        <div className="mt-3 flex rounded-xl border border-[var(--border)] p-1">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              onClick={() => setOnline(v)}
              className={clsx(
                "flex-1 rounded-lg py-1.5 text-sm font-medium transition-colors",
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
          <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-faint" />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contact name or company..."
              className="field-bare"
            />
          </div>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Meeting topic (optional)"
            className="field-input"
          />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_92px] gap-3">
          {/* calendar */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <button onClick={() => shiftMonth(-1)} className="btn-soft grid h-7 w-7 place-items-center rounded-lg" aria-label="Previous month">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-medium">
                {MONTH_NAMES[view.month]} {view.year}
              </span>
              <button onClick={() => shiftMonth(1)} className="btn-soft grid h-7 w-7 place-items-center rounded-lg" aria-label="Next month">
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
                      "mx-auto grid h-7 w-7 place-items-center rounded-lg transition-colors",
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

          {/* time slots */}
          <div className="flex flex-col">
            <p className="mb-1.5 text-center text-[11px] font-medium text-muted">{selLabel}</p>
            <div className="flex max-h-[188px] flex-col gap-1.5 overflow-y-auto pr-0.5">
              {timeSlots.map((s) => (
                <button
                  key={s}
                  onClick={() => setSlot(s)}
                  className={clsx(
                    "rounded-lg border py-1.5 text-xs font-medium transition-colors",
                    slot === s
                      ? "border-transparent text-white"
                      : "border-[var(--border)] text-muted hover:border-[var(--border-strong)]"
                  )}
                  style={slot === s ? { background: "var(--accent)" } : undefined}
                >
                  {s}
                </button>
              ))}
            </div>
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

      {/* meeting notes */}
      <Card className="!p-4">
        <p className="mb-2 text-sm font-semibold">Meeting Notes</p>
        <textarea
          rows={4}
          placeholder="Write any notes or relevant info about this meeting..."
          className="field-input"
        />
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
