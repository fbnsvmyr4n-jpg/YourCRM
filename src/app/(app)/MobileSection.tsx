"use client";

import { useCallback, useSyncExternalStore } from "react";
import { ChevronDown } from "lucide-react";
import { clsx } from "@/lib/clsx";

/**
 * A dashboard section that is folded away on a phone and always open above it.
 *
 * The dashboard renders ten cards. On a desktop they sit in two columns and
 * read as a dashboard; collapsed to one column they become ten full-width
 * cards stacked end to end, every one of them expanded, competing for the same
 * attention. That is the "cluttered and overstimulating" — not any single card,
 * but all of them shouting at once with no hierarchy between them.
 *
 * So on a phone the essentials stay open — the time, the greeting and its
 * counts, today's focus, the quick actions — and everything that is a *report*
 * rather than a *next action* folds behind its own title. The page becomes a
 * short list of labelled things, and the reader opens the one they came for.
 *
 * `sm:block` on the body is unconditional, and the control is `sm:hidden`, so
 * from `sm` up the layout never consults this state and the desktop dashboard
 * is exactly what it was.
 */
export function MobileSection({
  title,
  hint,
  tone,
  children,
  defaultOpen = false,
}: {
  title: string;
  /** A count or figure worth seeing without opening it. */
  hint?: string;
  /**
   * The section's colour, in the language the Leads page already speaks:
   * `{ color, soft }` from the same palette its status tones come from.
   */
  tone: { color: string; soft: string };
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const id = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const key = `dash-open:${id}`;

  /*
     It remembers, because otherwise a fold is a tax rather than a tidy-up.

     Reported as tedious, and rightly: somebody who opens Revenue every morning
     was re-opening it every morning. The choice belongs to the reader, and
     making them repeat it daily is the app being tidy at their expense.

     `useSyncExternalStore` rather than an effect writing state. Stored
     preferences ARE an external mutable source, which is what the hook exists
     for, and it keeps the server and client snapshots explicitly separate — the
     server has no `localStorage`, so it renders the default and the client
     reads the real value on hydration with no mismatch and no cascading
     render. Setting state inside an effect to do the same thing is what the
     React compiler rejects, and it is right to.
  */
  const open = useSyncExternalStore(
    subscribe,
    () => read(key, defaultOpen),
    () => defaultOpen
  );

  const toggle = useCallback(() => write(key, !read(key, defaultOpen)), [key, defaultOpen]);

  return (
    /*
       Open, this is ONE card — not a header floating above a separate one.

       It read as two boxes: a pill, a gap, then whatever card was inside. The
       heading did not look like it owned the thing under it, so opening a
       section produced two objects rather than one section with a title. When
       open the border and the radius move to this element and the header loses
       both, so the group is a single rounded box with a titled top edge and
       the cards nested inside it.
    */
    <section
      className={clsx(
        "flex flex-col sm:contents",
        open && "overflow-hidden rounded-2xl border border-[var(--border)]"
      )}
    >
      {/* The header exists only on a phone. On a desktop these cards carry
          their own headings and a second one would be a duplicate. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={id}
        className={clsx(
          "focus-ring flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors sm:hidden",
          /* Closed it is its own rounded object; open it is the top edge of the
             group below it, so it gives up its border and its radius. */
          open
            ? "border-b border-[var(--border)]"
            : "rounded-2xl border border-[var(--border)]"
        )}
        /* The same wash the Leads cards use — `linear-gradient(135deg, soft,
           transparent 90%)` — so a fold on the dashboard and a filter on Leads
           read as the same family rather than two designs in one product. */
        style={{ background: `linear-gradient(135deg, ${tone.soft}, transparent 90%)` }}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {/* The tone, stated once. Leads uses a filled dot for the same job. */}
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: tone.color }}
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{title}</span>
            {hint && <span className="mt-0.5 block truncate text-[11px] text-faint">{hint}</span>}
          </span>
        </span>
        <ChevronDown
          className={clsx("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")}
          style={{ color: tone.color }}
        />
      </button>

      {/*
          Inset, so the cards inside read as contents rather than as siblings of
          the header. The tint is the same tone at a fraction of the strength —
          enough to tie the group together, not enough to compete with the cards
          sitting on it.
      */}
      <div
        id={id}
        className={clsx("sm:contents", open ? "flex flex-col gap-4 p-3" : "hidden")}
        style={open ? { background: `linear-gradient(180deg, ${tone.soft}, transparent 60%)` } : undefined}
      >
        {children}
      </div>
    </section>
  );
}

/*
   A tiny store over `localStorage`, shared by every section on the page.

   Every access is guarded. Private windows, cleared site data and browsers set
   to block site data all THROW here rather than returning null, and a dashboard
   must not fail to render because a preference could not be read. Losing the
   memory is a small thing; losing the page is not.
*/
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  /* Another tab is a legitimate second writer, and `storage` only fires there —
     never in the tab that made the change, which is why writes below notify
     the local listeners by hand. */
  const onStorage = () => onChange();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function read(key: string, fallback: boolean): boolean {
  try {
    const saved = window.localStorage.getItem(key);
    return saved === null ? fallback : saved === "1";
  } catch {
    return fallback;
  }
}

function write(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* Not being able to remember is not a reason to refuse to open. */
  }
  for (const listener of listeners) listener();
}
