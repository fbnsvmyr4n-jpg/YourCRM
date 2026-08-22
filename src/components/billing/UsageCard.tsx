import { Activity } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { formatMicros, type UsageSummary, type WorkspaceUsage } from "@/server/usage";

/**
 * What this workspace has cost to run this month.
 *
 * Shown rather than hidden because the number exists to inform a decision, and
 * a figure nobody looks at informs nothing. It is OUR cost, not a charge — the
 * plans are flat, and nothing here bills anybody. Saying so plainly is the
 * difference between useful information and a customer thinking a surprise
 * invoice is coming.
 *
 * Nothing is invented when there is no usage: an empty month says so.
 */

const LABEL: Record<string, { name: string; unit: string }> = {
  ai_message: { name: "AI assistant", unit: "messages" },
  voice_minute: { name: "Inbound calls", unit: "minutes" },
  sms: { name: "Text messages", unit: "segments" },
};

export function UsageCard({
  usage,
  byWorkspace = [],
}: {
  usage: UsageSummary;
  /**
   * Per-client costs, shown only to an agency that has more than one client.
   *
   * A breakdown of one workspace against itself is the same number twice. This
   * is also the figure an agency on SaaS Pro rebills from, so it is theirs to
   * see — it reports what each workspace consumed, never anything from inside
   * it.
   */
  byWorkspace?: WorkspaceUsage[];
}) {
  return (
    <Card>
      <CardHeader title="Usage this month" icon={<Activity className="h-[18px] w-[18px] text-accent" />} />

      {usage.lines.length === 0 ? (
        <p className="text-sm text-faint">
          Nothing used yet this month. The AI assistant and inbound calls are
          counted here as they happen.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {usage.lines.map((line) => {
              const label = LABEL[line.kind] ?? { name: line.kind, unit: "" };
              return (
                <li
                  key={line.kind}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl px-3.5 py-3"
                  style={{ background: "var(--surface-2)" }}
                >
                  <div className="min-w-0 leading-tight">
                    <p className="truncate text-sm font-medium">{label.name}</p>
                    <p className="mt-0.5 text-xs text-faint tabular-nums">
                      {line.quantity.toLocaleString()} {label.unit}
                      {line.kind !== "ai_message" && ` · ${line.events.toLocaleString()} calls`}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">
                    {formatMicros(line.costMicros)}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 flex items-center justify-between border-t border-[var(--border)] pt-3">
            <p className="text-sm font-medium">Running cost</p>
            <p className="text-sm font-semibold tabular-nums">
              {formatMicros(usage.totalCostMicros)}
            </p>
          </div>
        </>
      )}

      {byWorkspace.length > 1 && (
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">
            By client workspace
          </p>
          <ul className="flex flex-col gap-1.5">
            {byWorkspace.map((w) => (
              <li key={w.subAccountId} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm">
                  {w.name}
                  {w.isPrimary && (
                    <span className="ml-2 text-xs text-faint">your own business</span>
                  )}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-muted">
                  {formatMicros(w.costMicros)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The plans are flat. Without this line a running total reads as a bill
          about to arrive, which is both wrong and alarming. */}
      <p className="mt-3 text-xs text-faint">
        Included in your plan — this is what it costs us to run, shown so there
        are no surprises later. You are not charged for it.
      </p>
    </Card>
  );
}
