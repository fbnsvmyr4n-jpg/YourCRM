import { Users } from "lucide-react";
import { Card } from "@/components/ui/Card";
import type { MeetingAnalytics } from "@/server/meeting-analytics";
import type { UpcomingMeeting } from "@/data/meetings";

/**
 * How booked up the diary is, and what has been done about it.
 *
 * Lifted out of the meetings page and onto Reports. It answers a reporting
 * question — how loaded am I, how much is still to be marked up — rather than a
 * booking one, and the meetings page is for booking and rebooking. Keeping a
 * second copy on that page would have been the same numbers in two places, and
 * the two would have drifted the moment either changed.
 *
 * No hooks and no state: it renders what it is handed, which is what lets a
 * server-rendered Reports page use it directly.
 */
/** "Mon 11 Aug" from a stored `YYYY-MM-DD`, parsed as UTC so it can't slip a day. */
export function shortDate(iso?: string) {
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

export function WorkloadCapacity({
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

      {/*
          The online / in-person split.

          It came from the "Meetings" card on the meetings page, which was
          counting the same meetings this card is about. That card stayed behind
          and this one moved to Reports, so the split is no longer a duplicate
          of anything and shows at every width.
      */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-[var(--border)] p-3">
          <p className="text-[11px] text-faint">Online</p>
          <p className="mt-0.5 text-lg font-bold tabular-nums text-accent">{analytics.byType.online}</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] p-3">
          <p className="text-[11px] text-faint">In-person</p>
          <p className="mt-0.5 text-lg font-bold tabular-nums text-purple">{analytics.byType.inPerson}</p>
        </div>
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
