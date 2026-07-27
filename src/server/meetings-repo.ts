import type { AvatarColor } from "@/components/ui/Avatar";
import {
  LOSS_REASONS,
  upcomingMeetings as seed,
  type LossReason,
  type MeetingOutcome,
  type MeetingType,
  type MeetingWhen,
  type UpcomingMeeting,
} from "@/data/meetings";
import { mutateTable, readTable } from "./store";

const TABLE = "meetings";

const COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

export type NewMeeting = {
  name: string;
  company: string;
  topic: string;
  /** `YYYY-MM-DD`. The label is derived from this, never stored as the truth. */
  date: string;
  time: string;
  type: MeetingType;
};

function initialsFor(name: string) {
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? "";
  const b = parts[1]?.[0] ?? "";
  return (a + b || name.trim().slice(0, 2)).toUpperCase();
}

// keep the seed's chronological ordering: Today → Tomorrow → This Week
const ORDER: Record<UpcomingMeeting["when"], number> = {
  Today: 0,
  Tomorrow: 1,
  "This Week": 2,
};

function sortMeetings<T extends UpcomingMeeting>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const byWhen = ORDER[a.when] - ORDER[b.when];
    if (byWhen !== 0) return byWhen;
    // Within a bucket, real dates order properly; undated rows keep their place.
    return (a.date ?? "").localeCompare(b.date ?? "");
  });
}

/** Local calendar date as `YYYY-MM-DD` — not `toISOString`, which shifts by timezone. */
export function toDateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * The label is derived, never trusted from storage. This is the whole point of
 * keeping a real date: "Today" stops being true the next morning, so it has to
 * be recomputed on every read rather than frozen at creation time.
 *
 * Anything in the past reads as "Today" so it stays visible in the Upcoming
 * list rather than silently vanishing into a bucket that doesn't exist.
 */
function whenFor(date: string | undefined, fallback: MeetingWhen): MeetingWhen {
  if (!date) return fallback; // written before dates existed
  const today = new Date();
  const t = Date.parse(`${toDateKey(today)}T00:00:00`);
  const d = Date.parse(`${date}T00:00:00`);
  if (!Number.isFinite(d)) return fallback;

  const days = Math.round((d - t) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return "This Week";
}

/**
 * Read-time normalisation: a meeting nobody has marked up is "scheduled", and
 * the Today/Tomorrow label is recomputed from the stored date.
 */
function normalise(m: UpcomingMeeting): UpcomingMeeting & { outcome: MeetingOutcome } {
  return {
    ...m,
    outcome: m.outcome ?? "scheduled",
    when: whenFor(m.date, m.when),
  };
}

export async function listMeetings(): Promise<(UpcomingMeeting & { outcome: MeetingOutcome })[]> {
  const rows = await readTable<UpcomingMeeting>(TABLE, seed);
  return sortMeetings(rows.map(normalise));
}

/** Record what happened. `lossReason` only sticks when the outcome is "lost". */
export async function setMeetingOutcome(
  id: string,
  outcome: MeetingOutcome,
  lossReason?: LossReason
): Promise<void> {
  await mutateTable<UpcomingMeeting>(TABLE, seed, (rows) => {
    const idx = rows.findIndex((m) => m.id === id);
    if (idx === -1) return rows;

    const next = [...rows];
    next[idx] = {
      ...next[idx],
      outcome,
      lossReason: outcome === "lost" ? (lossReason ?? "Other") : undefined,
      // Someone attended, so the booking is no longer merely pending.
      status: outcome === "scheduled" ? next[idx].status : "Confirmed",
    };
    return next;
  });
}

export async function createMeeting(input: NewMeeting): Promise<UpcomingMeeting> {
  let meeting!: UpcomingMeeting;
  await mutateTable<UpcomingMeeting>(TABLE, seed, (rows) => {
    const name = input.name.trim() || "New Contact";
    meeting = {
      id: `mtg-${Math.random().toString(36).slice(2, 8)}`,
      date: input.date,
      // Stored so undated legacy rows have something, but always recomputed
      // from `date` on read — see `whenFor`.
      when: whenFor(input.date, "This Week"),
      time: input.time,
      initials: initialsFor(name),
      color: COLORS[rows.length % COLORS.length],
      name,
      company: input.company.trim() || "—",
      topic: input.topic.trim() || "Meeting",
      type: input.type,
      status: "Pending",
    };
    return [meeting, ...rows];
  });
  return meeting;
}

export async function deleteMeeting(id: string): Promise<void> {
  await mutateTable<UpcomingMeeting>(TABLE, seed, (rows) => rows.filter((m) => m.id !== id));
}

/* ---------------- analytics ---------------- */

export type MeetingAnalytics = {
  total: number;
  /** Meetings whose outcome is still unrecorded — the honest denominator caveat. */
  pending: number;
  /** Meetings with a recorded outcome; every rate below is out of this. */
  decided: number;
  showed: number;
  noShow: number;
  advanced: number;
  won: number;
  lost: number;
  showRate: number | null;
  conversion: number | null;
  lossRate: number | null;
  funnel: { label: string; value: number; pct: number }[];
  lossReasons: { label: string; count: number; pct: number }[];
  byType: { online: number; inPerson: number };
};

function pct(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * Every figure on the Meetings page, counted from recorded outcomes.
 *
 * Rates are `null` rather than 0 when nothing has been recorded yet, so the UI
 * can say "no data" instead of presenting an unearned 0%. `decided` excludes
 * still-scheduled meetings — rating a team on meetings that haven't happened
 * yet would understate every rate.
 */
export async function meetingAnalytics(): Promise<MeetingAnalytics> {
  const rows = await listMeetings();

  const count = (o: MeetingOutcome) => rows.filter((m) => m.outcome === o).length;
  const total = rows.length;
  const pending = count("scheduled");
  const decided = total - pending;

  const noShow = count("no-show");
  const won = count("won");
  const lost = count("lost");
  // The funnel is cumulative: anything that advanced necessarily showed up.
  const advanced = count("advanced") + won;
  const showed = count("showed") + advanced + lost;

  const funnel = [
    { label: "Booked", value: total, pct: 100 },
    { label: "Showed Up", value: showed, pct: pct(showed, total) },
    { label: "Advanced", value: advanced, pct: pct(advanced, total) },
    { label: "Closed Won", value: won, pct: pct(won, total) },
  ];

  const reasonCounts = LOSS_REASONS.map((label) => ({
    label,
    count: rows.filter((m) => m.outcome === "lost" && m.lossReason === label).length,
  }))
    // A no-show is a loss with an obvious reason; fold it in so the panel
    // accounts for every lost opportunity rather than only the annotated ones.
    .map((r) => (r.label === "No-show" ? { ...r, count: r.count + noShow } : r))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);

  const totalLost = lost + noShow;

  return {
    total,
    pending,
    decided,
    showed,
    noShow,
    advanced,
    won,
    lost,
    showRate: decided > 0 ? pct(showed, decided) : null,
    conversion: decided > 0 ? pct(won, decided) : null,
    lossRate: decided > 0 ? pct(totalLost, decided) : null,
    funnel,
    lossReasons: reasonCounts.map((r) => ({ ...r, pct: pct(r.count, totalLost) })),
    byType: {
      online: rows.filter((m) => m.type === "Online").length,
      inPerson: rows.filter((m) => m.type === "In-Person").length,
    },
  };
}
