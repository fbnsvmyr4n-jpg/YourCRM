"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { clsx } from "@/lib/clsx";

export type ReportSection = {
  id: string;
  /** The page these figures are about, named as the sidebar names it. */
  label: string;
  /** A figure worth seeing without opening the section. */
  hint?: string;
  tone: { color: string; soft: string };
  content: React.ReactNode;
};

/**
 * The reports page, grouped by the page each number is about.
 *
 * It was eleven cards in one column on a phone and a long two-column scroll on
 * a desktop, in no order anybody could name: revenue, then leads, then voice,
 * then lead status, then meetings, then deals again. Finding "how are my leads
 * doing" meant scrolling past everything else and recognising the right card by
 * its heading.
 *
 * Now the areas are named — the same names the sidebar uses — and a row of tabs
 * jumps to one. "All" keeps the whole report, with each area behind the same
 * fold the dashboard's sections use, so the page opens as a short list of
 * labelled things rather than a wall.
 *
 * Every section is rendered whichever tab is showing, and hidden with CSS. The
 * cards are server-rendered with the period's data already in them, so
 * switching tab is instant and changes no data — a filter over one report, not
 * eleven trips to the server.
 */
export function ReportSections({ sections }: { sections: ReportSection[] }) {
  const [tab, setTab] = useState<string>("all");
  const showingAll = tab === "all";

  return (
    <>
      {/*
          A grid, not a wrapping row.

          Seven tabs of different word-lengths let the available width decide
          where the breaks fall, which on the meetings page produced three
          ragged lines that fitted on one machine and not on a phone. Equal
          columns break the same way everywhere.
      */}
      <div className="mt-5 grid grid-cols-3 gap-1.5 @min-[560px]:grid-cols-6 @min-[880px]:flex @min-[880px]:flex-wrap @min-[880px]:items-center @min-[880px]:gap-2">
        <TabButton id="all" label="All" active={showingAll} onSelect={setTab} />
        {sections.map((s) => (
          <TabButton
            key={s.id}
            id={s.id}
            label={s.label}
            tone={s.tone}
            active={tab === s.id}
            onSelect={setTab}
          />
        ))}
      </div>

      {sections.map((s) => (
        <Section key={s.id} section={s} open={tab === s.id} folded={showingAll} hidden={!showingAll && tab !== s.id} />
      ))}
    </>
  );
}

function TabButton({
  id,
  label,
  tone,
  active,
  onSelect,
}: {
  id: string;
  label: string;
  tone?: { color: string; soft: string };
  active: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-pressed={active}
      className={clsx(
        "focus-ring truncate rounded-full px-2.5 py-2 text-[11px] font-semibold transition-colors @min-[880px]:px-3.5 @min-[880px]:py-1.5 @min-[880px]:text-xs",
        active ? "text-[var(--text)]" : "btn-soft text-muted hover:text-[var(--text)]"
      )}
      style={active ? { background: tone?.soft ?? "var(--accent-soft)", color: tone?.color } : undefined}
    >
      {label}
    </button>
  );
}

/**
 * One area of the report.
 *
 * Under "All" it is a fold, closed by default, exactly as the dashboard's
 * sections are — the page becomes a list of areas and the reader opens the one
 * they came for. Under its own tab there is nothing to choose between, so the
 * fold goes and the cards are simply shown.
 */
function Section({
  section,
  open,
  folded,
  hidden,
}: {
  section: ReportSection;
  open: boolean;
  folded: boolean;
  hidden: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = `report-${section.id}`;
  const showBody = folded ? expanded : open;

  if (hidden) return null;

  return (
    <section
      className={clsx(
        "mt-4 flex flex-col",
        /* The box only exists while the fold is doing something — on a desktop
           under "All" the body is open anyway and a border round it would be a
           second frame drawn around cards that already have one. */
        folded && showBody && "overflow-hidden rounded-2xl border border-[var(--border)] @min-[880px]:border-0"
      )}
    >
      {/* A plain label where there is room for the whole report, so the areas
          still read as areas without asking anyone to open four folds. */}
      {folded && (
        <p className="mb-1 hidden items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint @min-[880px]:flex">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: section.tone.color }}
            aria-hidden
          />
          {section.label}
        </p>
      )}

      {folded && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className={clsx(
            /* The fold is a phone control. Above 880px the whole report fits
               and hiding it behind four taps would be tidiness at the reader's
               expense. */
            "focus-ring flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors @min-[880px]:hidden",
            expanded ? "border-b border-[var(--border)]" : "rounded-2xl border border-[var(--border)]"
          )}
          style={{ background: `linear-gradient(135deg, ${section.tone.soft}, transparent 90%)` }}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: section.tone.color }}
              aria-hidden
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{section.label}</span>
              {section.hint && (
                <span className="mt-0.5 block truncate text-[11px] text-faint">{section.hint}</span>
              )}
            </span>
          </span>
          <ChevronDown
            className={clsx("h-4 w-4 shrink-0 transition-transform", expanded && "rotate-180")}
            style={{ color: section.tone.color }}
          />
        </button>
      )}

      <div
        id={bodyId}
        className={clsx(
          showBody
            ? "flex flex-col gap-5"
            : /* Closed on a phone, open on a desktop — the fold is the phone's
                 answer to eleven stacked cards, not the desktop's. */
              clsx("hidden", folded && "@min-[880px]:flex @min-[880px]:flex-col @min-[880px]:gap-5"),
          folded && showBody && "p-3 @min-[880px]:p-0"
        )}
        style={
          /* The tint belongs to the fold; without the fold it would be a wash
             behind cards for no reason. */
          folded && showBody ? { background: `linear-gradient(180deg, ${section.tone.soft}, transparent 60%)` } : undefined
        }
      >
        {section.content}
      </div>
    </section>
  );
}
