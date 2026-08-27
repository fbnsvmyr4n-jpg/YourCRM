"use client";

import { useSyncExternalStore } from "react";
import { CalendarDays } from "lucide-react";

/**
 * The date and time, as their own panel.
 *
 * They used to be a 12px uppercase eyebrow sitting on top of "Good evening,
 * Bradley 👋" — a caption on a greeting rather than information in their own
 * right. Anyone actually wanting the time read past it to the browser's own
 * clock, which is what a piece of chrome nobody trusts looks like.
 *
 * It also fixes a real disagreement rather than only moving pixels. The date
 * was `new Date().toLocaleDateString(...)` with no time zone, which is the
 * SERVER's zone — UTC on Vercel — while "Meetings Today" a few pixels below it
 * was already filtered by the business's own zone. At 01:00 in Johannesburg
 * the header printed yesterday's date beside a count of today's meetings, and
 * both looked authoritative. Everything here now takes the same `timeZone` the
 * rest of the page counts by, so the two cannot disagree again.
 */

function subscribe(onChange: () => void): () => void {
  // Aligned to the next whole second so the display flips when the clock does,
  // not up to a second late.
  let interval: ReturnType<typeof setInterval>;
  const align = setTimeout(() => {
    onChange();
    interval = setInterval(onChange, 1000);
  }, 1000 - (Date.now() % 1000));

  return () => {
    clearTimeout(align);
    clearInterval(interval);
  };
}

/** Whole seconds — a millisecond snapshot would re-render on every read. */
const getSnapshot = () => Math.floor(Date.now() / 1000);
/**
 * `null` on the server on purpose. The server and the reader can sit in
 * different zones, so rendering a live time during SSR would both cause a
 * hydration mismatch and briefly show the server's idea of the time.
 */
const getServerSnapshot = (): number | null => null;

export function DateTimeBar({
  timeZone,
  /** Rendered on the server in `timeZone`, so the first paint is already right. */
  initialDate,
}: {
  timeZone: string;
  initialDate: string;
}) {
  const seconds = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const live = seconds !== null;
  const at = live ? new Date(seconds * 1000) : null;

  /* Once ticking, the date comes from the same instant as the time, so it
     rolls over at midnight without a reload and cannot drift from the clock
     beside it. Before that it is the server's value, formatted in the same
     zone by the same rules. */
  const dateFull =
    at?.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone,
    }) ?? initialDate;

  const dateShort =
    at?.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone,
    }) ?? initialDate;

  const time = at?.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  });

  /* The zone label is derived from the same `timeZone` that formats the clock,
     so it can never caption a time it does not describe. */
  const zone = at
    ? new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value
    : undefined;

  return (
    <div className="card flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
          style={{ background: "var(--accent-soft)" }}
        >
          <CalendarDays className="h-[18px] w-[18px] text-accent" />
        </span>
        <div className="min-w-0 leading-tight">
          {/*
              A shorter date rather than a truncated one.

              "Wednesday, 27 August 2026" needs about 210px and a 375px phone
              has roughly 150px here once the icon and the clock are placed, so
              it could only ever render as "Wednesday, 27 Aug…" — a layout that
              looks broken rather than one that adapted. Both spans carry the
              same styling; only one is ever displayed.
          */}
          <p className="truncate text-sm font-semibold">
            <span className="min-[430px]:hidden">{dateShort}</span>
            <span className="hidden min-[430px]:inline">{dateFull}</span>
          </p>
          <p className="text-[11px] text-faint">
            {/* Reserved, not omitted: without a placeholder the second line
                appears at hydration and shoves the first one upward. */}
            <span style={{ visibility: zone ? undefined : "hidden" }}>{zone ?? "GMT"}</span>
            {/* "Local time" was the first label and it is not true: this clock
                runs in the BUSINESS's zone, which is the viewer's local time
                only when the two happen to match. Someone reading this from
                another country would be told their own local time and shown
                the office's. */}
            {" · Business time"}
          </p>
        </div>
      </div>

      <p
        className="shrink-0 text-2xl font-bold tabular-nums tracking-tight text-accent sm:text-[28px]"
        /* The width is reserved before hydration so nothing shifts when the
           clock arrives. */
        style={{ visibility: live ? undefined : "hidden" }}
        suppressHydrationWarning
      >
        {time ?? "00:00:00"}
      </p>
    </div>
  );
}
