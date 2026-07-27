"use client";

import { useMemo, useState } from "react";
import {
  Building2,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Sparkles,
  UserRound,
  Video,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { clsx } from "@/lib/clsx";
import { OUTCOME_LABELS, type MeetingOutcome, type UpcomingMeeting } from "@/data/meetings";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** Online vs in-person is a real field on every meeting; colour by that. */
const TYPE_STYLE = {
  Online: { color: "var(--accent)", soft: "var(--accent-soft)", icon: Video, label: "Online" },
  "In-Person": { color: "var(--purple)", soft: "var(--purple-soft)", icon: UserRound, label: "In-person" },
} as const;

const OUTCOME_COLOR: Record<MeetingOutcome, string> = {
  scheduled: "var(--amber)",
  "no-show": "var(--red)",
  showed: "var(--accent)",
  advanced: "var(--purple)",
  won: "var(--green)",
  lost: "var(--red)",
};

type DayRef = { year: number; month: number; day: number };

/** Split `YYYY-MM-DD` without going through Date, which shifts by timezone. */
function parseDateKey(key: string | undefined): DayRef | null {
  if (!key) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) };
}

export default function CalendarView({
  meetings,
  today,
}: {
  meetings: UpcomingMeeting[];
  today: DayRef;
}) {
  const [view, setView] = useState({ year: today.year, month: today.month });
  const [selectedId, setSelectedId] = useState<string | null>(meetings[0]?.id ?? null);

  // Meetings written before dates existed have nothing to place on a grid —
  // they're surfaced below the calendar rather than dropped silently.
  const { dated, undated } = useMemo(() => {
    const dated: (UpcomingMeeting & { on: DayRef })[] = [];
    const undated: UpcomingMeeting[] = [];
    for (const m of meetings) {
      const on = parseDateKey(m.date);
      if (on) dated.push({ ...m, on });
      else undated.push(m);
    }
    return { dated, undated };
  }, [meetings]);

  const cells = useMemo(() => monthGrid(view.year, view.month), [view]);
  const monthMeetings = dated.filter(
    (m) => m.on.year === view.year && m.on.month === view.month
  );

  const selected = meetings.find((m) => m.id === selectedId) ?? meetings[0] ?? null;

  const shiftMonth = (dir: number) => {
    let m = view.month + dir;
    let y = view.year;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setView({ year: y, month: m });
  };

  const online = monthMeetings.filter((m) => m.type === "Online").length;
  const inPerson = monthMeetings.filter((m) => m.type === "In-Person").length;

  return (
    <div className="mx-auto grid max-w-[1500px] animate-fade-up grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card className="flex flex-col !p-0">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <button onClick={() => shiftMonth(-1)} className="btn-soft focus-ring grid h-9 w-9 place-items-center rounded-xl" aria-label="Previous month">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button onClick={() => shiftMonth(1)} className="btn-soft focus-ring grid h-9 w-9 place-items-center rounded-xl" aria-label="Next month">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <h1 className="text-2xl font-bold tracking-tight">
              {MONTHS[view.month]} <span className="text-accent">{view.year}</span>
            </h1>
          </div>
          <button
            onClick={() => setView({ year: today.year, month: today.month })}
            className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium"
          >
            <CalendarIcon className="h-4 w-4 text-accent" /> Today
          </button>
        </div>

        {/* Weekday header */}
        <div className="grid grid-cols-7 border-y border-[var(--border)] bg-[var(--raise)]/40">
          {DOW.map((d) => (
            <div key={d} className="px-3 py-2.5 text-xs font-semibold tracking-wide text-faint">
              {d}
            </div>
          ))}
        </div>

        {/* Grid */}
        <div className="grid flex-1 grid-cols-7 grid-rows-6">
          {cells.map((c, i) => {
            const dayMeetings = c.inMonth ? monthMeetings.filter((m) => m.on.day === c.day) : [];
            const isToday =
              c.inMonth && view.year === today.year && view.month === today.month && c.day === today.day;
            return (
              <div
                key={i}
                className={clsx(
                  "min-h-[112px] border-b border-r border-[var(--border)] p-1.5",
                  i % 7 === 0 && "border-l",
                  !c.inMonth && "bg-[var(--raise)]/30"
                )}
              >
                <p
                  className={clsx(
                    "mb-1 inline-grid h-6 min-w-6 place-items-center rounded-full px-1 text-sm font-medium",
                    isToday && "bg-[var(--accent)] text-white",
                    !isToday && (c.inMonth ? "text-[var(--text)]" : "text-faint opacity-50")
                  )}
                >
                  {c.day}
                </p>
                <div className="space-y-1">
                  {dayMeetings.map((m) => (
                    <MeetingPill
                      key={m.id}
                      meeting={m}
                      active={m.id === selectedId}
                      onClick={() => setSelectedId(m.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Legend — counted from what's actually on this month */}
        <div className="flex flex-wrap items-center gap-2 p-4">
          <span className="flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-medium">
            <span className="h-2 w-2 rounded-full" style={{ background: "var(--accent)" }} />
            Online ({online})
          </span>
          <span className="flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-medium">
            <span className="h-2 w-2 rounded-full" style={{ background: "var(--purple)" }} />
            In-person ({inPerson})
          </span>
          <span className="ml-auto text-xs text-faint">
            {monthMeetings.length} meeting{monthMeetings.length === 1 ? "" : "s"} in {MONTHS[view.month]}
          </span>
        </div>

        {undated.length > 0 && (
          <div className="border-t border-[var(--border)] p-4">
            <p className="text-xs text-faint">
              {undated.length} meeting{undated.length === 1 ? "" : "s"} booked before dates were
              recorded ({undated.map((m) => m.name).join(", ")}) — they appear in Meetings but
              can&apos;t be placed on a day.
            </p>
          </div>
        )}
      </Card>

      <MeetingDetails meeting={selected} />
    </div>
  );
}

function MeetingPill({
  meeting,
  active,
  onClick,
}: {
  meeting: UpcomingMeeting;
  active: boolean;
  onClick: () => void;
}) {
  const style = TYPE_STYLE[meeting.type];
  const Icon = style.icon;
  return (
    <button
      onClick={onClick}
      className={clsx(
        "focus-ring w-full rounded-md border-l-2 px-1.5 py-1 text-left transition-shadow",
        active && "ring-1"
      )}
      style={{
        borderLeftColor: style.color,
        background: style.soft,
        ...(active ? ({ "--tw-ring-color": style.color } as React.CSSProperties) : {}),
      }}
    >
      <p className="flex items-start gap-1 text-[11px] font-medium leading-tight">
        <Icon className="mt-0.5 h-3 w-3 shrink-0" style={{ color: style.color }} />
        <span className="line-clamp-2">{meeting.name}</span>
      </p>
      <p className="mt-0.5 flex items-center gap-1 text-[10px] text-faint">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: OUTCOME_COLOR[meeting.outcome ?? "scheduled"] }}
        />
        {meeting.time}
      </p>
    </button>
  );
}

/* ---------------- Details rail ---------------- */

function MeetingDetails({ meeting }: { meeting: UpcomingMeeting | null }) {
  if (!meeting) {
    return (
      <Card className="flex flex-col gap-5">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Sparkles className="h-[18px] w-[18px] text-accent" /> Meeting Details
        </h2>
        <p className="py-10 text-center text-sm text-faint">
          No meetings yet. Book one from the Meetings page and it appears here.
        </p>
      </Card>
    );
  }

  const outcome = meeting.outcome ?? "scheduled";
  const style = TYPE_STYLE[meeting.type];
  const on = parseDateKey(meeting.date);
  const dateLabel = on
    ? new Date(on.year, on.month, on.day).toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : `${meeting.when} (no date recorded)`;

  return (
    <Card className="flex flex-col gap-5">
      <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <Sparkles className="h-[18px] w-[18px] text-accent" /> Meeting Details
      </h2>

      <div className="flex items-center gap-3">
        <Avatar initials={meeting.initials} color={meeting.color} />
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold">{meeting.name}</p>
          <p className="truncate text-xs text-faint">{meeting.company}</p>
        </div>
      </div>

      <Field label="Topic">
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--border)] p-3">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <span className="text-sm text-muted">{meeting.topic}</span>
        </div>
      </Field>

      <Field label="Date">
        <div className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] p-3">
          <CalendarIcon className="h-4 w-4 shrink-0 text-accent" />
          <span className="text-sm font-medium">{dateLabel}</span>
        </div>
      </Field>

      <Field label="Time">
        <div className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] p-3">
          <Clock className="h-4 w-4 shrink-0 text-accent" />
          <span className="text-sm font-medium">{meeting.time}</span>
        </div>
      </Field>

      <Field label="Format">
        <div className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] p-3">
          <Building2 className="h-4 w-4 shrink-0" style={{ color: style.color }} />
          <span className="text-sm font-medium">{style.label}</span>
        </div>
      </Field>

      <Field label="Outcome">
        <span
          className="inline-block rounded-lg px-3 py-1.5 text-sm font-semibold"
          style={{ background: `${OUTCOME_COLOR[outcome]}22`, color: OUTCOME_COLOR[outcome] }}
        >
          {OUTCOME_LABELS[outcome]}
        </span>
        {outcome === "lost" && meeting.lossReason && (
          <p className="mt-2 text-xs text-faint">Reason: {meeting.lossReason}</p>
        )}
        <p className="mt-2 text-xs text-faint">Set the outcome from the Meetings page.</p>
      </Field>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium">{label}</p>
      {children}
    </div>
  );
}

/** Sunday-first 6x7 month grid with leading/trailing days. */
function monthGrid(year: number, month: number) {
  const startDow = new Date(year, month, 1).getDay(); // Sunday = 0
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
