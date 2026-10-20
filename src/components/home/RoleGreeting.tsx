import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { toneStyles, type Tone } from "@/components/ui/tone";

/**
 * The greeting card the role homes open with.
 *
 * The same card the sales Home uses — same wash, same tile — so moving
 * between roles does not feel like moving between products. What differs is
 * what the tiles count, and that there are only as many as the role has real
 * figures for: three for finance, none for IT, whose headline is a state
 * ("Everything is running") rather than a number.
 */
export type GreetingTile = {
  icon: LucideIcon;
  tone: Tone;
  label: string;
  value: string;
  /** A line of context under the figure, when the bare number needs one. */
  sub?: string;
};

export function RoleGreeting({
  greeting,
  name,
  summary,
  tiles = [],
  status,
}: {
  greeting: string;
  name: string;
  /** Omitted when there is nothing worth a sentence — never a filler line. */
  summary?: string;
  tiles?: GreetingTile[];
  /** A one-line state in place of tiles — IT's "Everything is running". */
  status?: { tone: Tone; text: string };
}) {
  return (
    <Card className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(120% 140% at 0% 0%, var(--accent-soft), transparent 55%), radial-gradient(120% 140% at 100% 0%, var(--purple-soft), transparent 55%)",
        }}
      />
      <div className="relative">
        <h2 className="text-2xl font-bold tracking-tight sm:text-[27px]">
          {greeting}, {name} 👋
        </h2>
        {summary && <p className="mt-1.5 text-sm text-muted">{summary}</p>}

        {status && (
          <p
            className="mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-1.5 text-sm font-medium"
            style={{ background: toneStyles[status.tone].soft, color: toneStyles[status.tone].color }}
          >
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ background: toneStyles[status.tone].color }}
            />
            {status.text}
          </p>
        )}

        {tiles.length > 0 && (
          /*
             THREE ACROSS AT EVERY WIDTH, compact on a phone.

             Stacked one per row, three tiles were ~290px on a 375px screen and
             pushed the list that matters — who to chase — below the fold. On a
             phone each tile drops its icon and its context line and keeps the
             figure and its label; the sentence above already says the thing the
             context lines add. From 520px (every desktop) the full tile is
             exactly as it was.
          */
          <div className="mt-4 grid grid-cols-3 gap-2 @min-[520px]:mt-5 @min-[520px]:gap-3">
            {tiles.map((t) => {
              const tone = toneStyles[t.tone];
              const Icon = t.icon;
              return (
                <div
                  key={t.label}
                  className="flex min-w-0 items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--panel-solid)]/40 p-2.5 @min-[520px]:p-3"
                >
                  <span
                    className="hidden h-10 w-10 shrink-0 place-items-center rounded-xl @min-[520px]:grid"
                    style={{ background: tone.soft }}
                  >
                    <Icon className="h-[18px] w-[18px]" style={{ color: tone.color }} />
                  </span>
                  <div className="min-w-0 leading-tight">
                    <p
                      className="truncate text-[15px] font-bold tabular-nums @min-[520px]:text-xl"
                      /* The tone survives the missing icon on a phone: an
                         overdue figure is still red. */
                      style={t.tone === "red" ? { color: tone.color } : undefined}
                    >
                      {t.value}
                    </p>
                    <p className="text-[10px] text-faint @min-[520px]:text-[11px]">
                      {t.label}
                      {t.sub && <span className="hidden @min-[520px]:inline"> · {t.sub}</span>}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
