"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  Building2,
  Calendar as CalendarIcon,
  CalendarDays,
  CalendarRange,
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
import { minutesOfDay, toDisplayTime } from "@/lib/time";
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
type Mode = "day" | "week" | "month";
type TypeFilter = "all" | "Online" | "In-Person";

/** Split `YYYY-MM-DD` without going through Date, which shifts by timezone. */
function parseDateKey(key: string | undefined): DayRef | null {
  if (!key) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) - 1, day: Number(m[3]) };
}

const sameDay = (a: DayRef, b: DayRef) => a.year === b.year && a.month === b.month && a.day === b.day;
const toDate = (d: DayRef) => new Date(d.year, d.month, d.day);
const fromDate = (d: Date): DayRef => ({ year: d.getFullYear(), month: d.getMonth(), day: d.getDate() });

/** Calendar arithmetic through Date, so month ends and leap years are handled. */
function addDays(d: DayRef, n: number): DayRef {
  const x = toDate(d);
  x.setDate(x.getDate() + n);
  return fromDate(x);
}

/**
 * Today, according to the reader's own clock.
 *
 * The server sends its date, which is what SSR renders. In production the
 * server runs in UTC while the user may not, so for a couple of hours each day
 * the two genuinely disagree — and "Today" is now a view people act on, not
 * just a highlight. The browser value wins as soon as it exists.
 */
function useToday(serverToday: DayRef): DayRef {
  const key = useSyncExternalStore(
    // Never changes during a session in any way worth re-rendering for; a page
    // left open across midnight is corrected by any other interaction.
    () => () => {},
    () => {
      const d = new Date();
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    },
    () => `${serverToday.year}-${serverToday.month}-${serverToday.day}`
  );

  return useMemo(() => {
    const [y, m, d] = key.split("-").map(Number);
    return { year: y, month: m, day: d };
  }, [key]);
}

export default function CalendarView({
  meetings,
  today: serverToday,
}: {
  meetings: UpcomingMeeting[];
  today: DayRef;
}) {
  const today = useToday(serverToday);

  const [mode, setMode] = useState<Mode>("month");
  const [anchor, setAnchor] = useState<DayRef>(serverToday);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  // Nothing selected until the user picks. Defaulting to `meetings[0]` opened
  // the page with whichever meeting happened to be first — often an undated one
  // whose Date field then read "no date recorded", on a calendar.
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const visible = useMemo(
    () => (typeFilter === "all" ? dated : dated.filter((m) => m.type === typeFilter)),
    [dated, typeFilter]
  );

  const forDay = useMemo(
    () => (d: DayRef) =>
      visible
        .filter((m) => sameDay(m.on, d))
        .sort((a, b) => minutesOfDay(a.time) - minutesOfDay(b.time)),
    [visible]
  );

  /** The days the current view covers. */
  const span = useMemo<DayRef[]>(() => {
    if (mode === "day") return [anchor];
    if (mode === "week") return Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
    return [];
  }, [mode, anchor]);

  const inView = useMemo(() => {
    if (mode === "month") {
      return visible.filter((m) => m.on.year === anchor.year && m.on.month === anchor.month);
    }
    return span.flatMap((d) => visible.filter((m) => sameDay(m.on, d)));
  }, [mode, anchor, span, visible]);

  const counts = useMemo(() => {
    const scope =
      mode === "month"
        ? dated.filter((m) => m.on.year === anchor.year && m.on.month === anchor.month)
        : span.flatMap((d) => dated.filter((m) => sameDay(m.on, d)));
    return {
      Online: scope.filter((m) => m.type === "Online").length,
      "In-Person": scope.filter((m) => m.type === "In-Person").length,
      all: scope.length,
    };
  }, [mode, anchor, span, dated]);

  const selected = meetings.find((m) => m.id === selectedId) ?? null;

  /** Step by whatever unit is on screen. */
  const shift = (dir: number) => {
    if (mode === "day") return setAnchor(addDays(anchor, dir));
    if (mode === "week") return setAnchor(addDays(anchor, dir * 7));
    let m = anchor.month + dir;
    let y = anchor.year;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setAnchor({ year: y, month: m, day: 1 });
  };

  const title = (() => {
    if (mode === "day") {
      return toDate(anchor).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    }
    if (mode === "week") {
      const end = addDays(anchor, 6);
      const sameMonth = anchor.month === end.month && anchor.year === end.year;
      const left = toDate(anchor).toLocaleDateString("en-GB", sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" });
      const right = toDate(end).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
      return `${left} – ${right}`;
    }
    return `${MONTHS[anchor.month]} ${anchor.year}`;
  })();

  const views: { id: Mode; label: string; icon: typeof CalendarIcon }[] = [
    { id: "day", label: "Today", icon: CalendarIcon },
    { id: "week", label: "This Week", icon: CalendarRange },
    { id: "month", label: "This Month", icon: CalendarDays },
  ];

  return (
    <div className="mx-auto grid max-w-[1500px] animate-fade-up grid-cols-1 gap-5 @min-[820px]:grid-cols-[minmax(0,1fr)_340px]">
      <Card className="flex flex-col !p-0">
        {/* Toolbar. Online / In-person used to be a static legend stranded at
            the very bottom of the page; they are now filters, and they sit
            left of the view switcher where they can be reached. */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <button onClick={() => shift(-1)} className="btn-soft focus-ring grid h-9 w-9 place-items-center rounded-xl" aria-label="Previous">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button onClick={() => shift(1)} className="btn-soft focus-ring grid h-9 w-9 place-items-center rounded-xl" aria-label="Next">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
              {mode === "month" ? (
                <>
                  {MONTHS[anchor.month]} <span className="text-accent">{anchor.year}</span>
                </>
              ) : (
                title
              )}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(["Online", "In-Person"] as const).map((t) => {
              const s = TYPE_STYLE[t];
              const active = typeFilter === t;
              const n = counts[t];
              return (
                <button
                  key={t}
                  onClick={() => setTypeFilter(active ? "all" : t)}
                  aria-pressed={active}
                  title={active ? `Show all meetings` : `Show only ${s.label.toLowerCase()} meetings`}
                  className={clsx(
                    "focus-ring flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    active ? "border-transparent" : "border-[var(--border)] hover:border-[var(--border-strong)]"
                  )}
                  style={active ? { background: s.soft, color: s.color } : undefined}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.label}
                  <span className="text-faint">{n}</span>
                </button>
              );
            })}

            <span className="mx-1 hidden h-5 w-px bg-[var(--border)] sm:block" />

            <div className="flex items-center gap-1 rounded-full border border-[var(--border)] p-1">
              {views.map((v) => {
                const Icon = v.icon;
                const active = mode === v.id;
                return (
                  <button
                    key={v.id}
                    onClick={() => {
                      setMode(v.id);
                      // Every switch re-anchors on today — "Today" that opened
                      // last month's grid was the original complaint.
                      setAnchor(v.id === "month" ? { ...today, day: 1 } : today);
                    }}
                    className={clsx(
                      "focus-ring flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                      active ? "text-accent" : "text-muted hover:text-[var(--text)]"
                    )}
                    style={active ? { background: "var(--accent-soft)" } : undefined}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {v.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {mode === "month" ? (
          <MonthGrid
            anchor={anchor}
            today={today}
            forDay={forDay}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onPickDay={(d) => {
              // Clicking a day drills into just that day's plan.
              setAnchor(d);
              setMode("day");
            }}
          />
        ) : (
          <Agenda days={span} today={today} forDay={forDay} selectedId={selectedId} onSelect={setSelectedId} />
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] p-4">
          <span className="text-xs text-faint">
            {inView.length} meeting{inView.length === 1 ? "" : "s"}
            {typeFilter !== "all" && ` (${TYPE_STYLE[typeFilter].label.toLowerCase()})`} in view
          </span>
          {typeFilter !== "all" && (
            <button onClick={() => setTypeFilter("all")} className="focus-ring text-xs text-accent hover:underline">
              Clear filter
            </button>
          )}
          {!sameDay(anchor, today) && mode !== "month" && (
            <button
              onClick={() => setAnchor(today)}
              className="focus-ring ml-auto text-xs text-accent hover:underline"
            >
              Back to today
            </button>
          )}
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

/* ---------------- Month grid ---------------- */

function MonthGrid({
  anchor,
  today,
  forDay,
  selectedId,
  onSelect,
  onPickDay,
}: {
  anchor: DayRef;
  today: DayRef;
  forDay: (d: DayRef) => (UpcomingMeeting & { on: DayRef })[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPickDay: (d: DayRef) => void;
}) {
  const cells = useMemo(() => monthGrid(anchor.year, anchor.month), [anchor.year, anchor.month]);

  return (
    <>
      <div className="grid grid-cols-7 border-y border-[var(--border)] bg-[var(--raise)]/40">
        {DOW.map((d) => (
          <div key={d} className="px-3 py-2.5 text-xs font-semibold tracking-wide text-faint">
            {d}
          </div>
        ))}
      </div>

      <div className="grid flex-1 grid-cols-7 grid-rows-6">
        {cells.map((c, i) => {
          const day: DayRef = { year: c.year, month: c.month, day: c.day };
          const dayMeetings = forDay(day);
          const isToday = sameDay(day, today);

          return (
            <div
              key={i}
              className={clsx(
                "group relative min-h-[112px] border-b border-r border-[var(--border)] p-1.5",
                i % 7 === 0 && "border-l",
                !c.inMonth && "bg-[var(--raise)]/30"
              )}
            >
              {/* The whole cell is the target — the report asked for clicking
                  *any* day, including the greyed-out neighbours. Sits behind
                  the pills so a pill click still selects that meeting. */}
              <button
                onClick={() => onPickDay(day)}
                className="focus-ring absolute inset-0 h-full w-full rounded-none transition-colors hover:bg-[var(--raise)]/50"
                aria-label={`Open ${toDate(day).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`}
              />

              <p
                className={clsx(
                  "pointer-events-none relative mb-1 inline-grid h-6 min-w-6 place-items-center rounded-full px-1 text-sm font-medium",
                  isToday && "bg-[var(--accent)] text-white",
                  !isToday && (c.inMonth ? "text-[var(--text)]" : "text-faint opacity-50")
                )}
              >
                {c.day}
              </p>

              <div className="relative space-y-1">
                {dayMeetings.map((m) => (
                  <MeetingPill key={m.id} meeting={m} active={m.id === selectedId} onClick={() => onSelect(m.id)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ---------------- Day / week agenda ---------------- */

function Agenda({
  days,
  today,
  forDay,
  selectedId,
  onSelect,
}: {
  days: DayRef[];
  today: DayRef;
  forDay: (d: DayRef) => (UpcomingMeeting & { on: DayRef })[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex-1 divide-y divide-[var(--border)] border-t border-[var(--border)]">
      {days.map((d) => {
        const rows = forDay(d);
        const isToday = sameDay(d, today);
        return (
          <div key={`${d.year}-${d.month}-${d.day}`} className="flex gap-4 p-4">
            <div className="w-24 shrink-0 sm:w-32">
              <p className={clsx("text-xs font-semibold uppercase tracking-wide", isToday ? "text-accent" : "text-faint")}>
                {toDate(d).toLocaleDateString("en-GB", { weekday: "short" })}
                {isToday && " · today"}
              </p>
              <p className="text-lg font-bold">{d.day}</p>
              <p className="text-xs text-faint">{MONTHS[d.month].slice(0, 3)}</p>
            </div>

            <div className="min-w-0 flex-1 space-y-2">
              {rows.length === 0 ? (
                <p className="py-2 text-sm text-faint">Nothing scheduled.</p>
              ) : (
                rows.map((m) => {
                  const s = TYPE_STYLE[m.type];
                  const Icon = s.icon;
                  const active = m.id === selectedId;
                  return (
                    <button
                      key={m.id}
                      onClick={() => onSelect(m.id)}
                      className={clsx(
                        "focus-ring flex w-full items-center gap-3 rounded-xl border-l-[3px] p-3 text-left transition-colors",
                        active ? "border border-[var(--border-strong)]" : "border border-[var(--border)] hover:border-[var(--border-strong)]"
                      )}
                      style={{ borderLeftColor: s.color, background: active ? s.soft : undefined }}
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg" style={{ background: s.soft }}>
                        <Icon className="h-4 w-4" style={{ color: s.color }} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{m.name}</p>
                        <p className="truncate text-xs text-faint">
                          {m.company} · {m.topic}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-semibold">{toDisplayTime(m.time)}</p>
                        <p className="flex items-center justify-end gap-1 text-[10px] text-faint">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: OUTCOME_COLOR[m.outcome ?? "scheduled"] }} />
                          {s.label}
                        </p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
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
        "focus-ring relative w-full rounded-md border-l-2 px-1.5 py-1 text-left transition-shadow",
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
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: OUTCOME_COLOR[meeting.outcome ?? "scheduled"] }} />
        {toDisplayTime(meeting.time)}
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
          Pick a meeting to see its details.
        </p>
      </Card>
    );
  }

  const outcome = meeting.outcome ?? "scheduled";
  const style = TYPE_STYLE[meeting.type];
  const on = parseDateKey(meeting.date);
  const dateLabel = on
    ? toDate(on).toLocaleDateString("en-GB", {
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
          <span className="text-sm font-medium">{toDisplayTime(meeting.time)}</span>
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

/**
 * Sunday-first 6x7 month grid.
 *
 * Leading and trailing cells carry their own real year/month, not just a day
 * number — clicking 31 July from the August grid has to open July, and a
 * bare day number can't say which month it belongs to.
 */
function monthGrid(year: number, month: number) {
  const startDow = new Date(year, month, 1).getDay(); // Sunday = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: { day: number; month: number; year: number; inMonth: boolean }[] = [];

  for (let i = 0; i < startDow; i++) {
    const d = new Date(year, month, 1 - (startDow - i));
    cells.push({ day: d.getDate(), month: d.getMonth(), year: d.getFullYear(), inMonth: false });
  }

  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, month, year, inMonth: true });

  let next = 1;
  while (cells.length < 42) {
    const d = new Date(year, month + 1, next++);
    cells.push({ day: d.getDate(), month: d.getMonth(), year: d.getFullYear(), inMonth: false });
  }

  return cells.slice(0, 42);
}
