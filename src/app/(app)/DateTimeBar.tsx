"use client";

import { useSyncExternalStore } from "react";
import { utcOffsetLabel } from "@/lib/zoned";

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
  /*
     Both rendered on the server in `timeZone`, so the first paint is already
     right rather than blank. Passed as two fields rather than one string the
     client splits: "Thursday, 27 August 2026" only splits on a comma in the
     locales that put one there, and that is a silent breakage the moment the
     format changes.
  */
  initialWeekday,
  initialDate,
}: {
  timeZone: string;
  initialWeekday: string;
  initialDate: string;
}) {
  const seconds = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const live = seconds !== null;
  const at = live ? new Date(seconds * 1000) : null;

  /* Once ticking, the date comes from the same instant as the time, so it
     rolls over at midnight without a reload and cannot drift from the clock
     beside it. Before that it is the server's value, formatted in the same
     zone by the same rules. */
  const weekday =
    at?.toLocaleDateString("en-GB", { weekday: "long", timeZone }) ?? initialWeekday;

  const dateFull =
    at?.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone,
    }) ?? initialDate;

  const dateShort =
    at?.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone,
    }) ?? initialDate;

  const time = at?.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  });

  /* Derived from the same `timeZone` that formats the clock, so it can never
     caption a time it does not describe. */
  const offset = at ? utcOffsetLabel(timeZone, at) : null;

  /* Split so the seconds can be de-emphasised: they change every tick and are
     the least useful part of a glanceable clock, but removing them makes it
     look frozen. */
  const [hhmm, ss] = (time ?? "00:00:00").split(/:(?=\d\d$)/);

  return (
    /*
       Quieter than it was.

       The first version led with a filled accent-blue icon tile and a large
       accent-blue clock, which made a piece of ambient information the loudest
       thing above the greeting. This states the same facts and stops competing:
       no icon block, one hairline rule separating the two halves, and colour
       reserved for the things on this page that actually mean something.
    */
    <div className="card flex items-center justify-between gap-4 px-5 py-3.5">
      <div className="min-w-0">
        {/*
            The offset belongs up here with the weekday, not under the clock.

            Sitting beneath the time it read as a caption ON the time and made
            the whole right-hand block feel like two competing lines, which is
            exactly what stopped the clock being the focal point. Up here it
            pairs with the weekday — both are small, tracked, secondary facts
            about the same instant — and the right side is left to the time
            alone.
        */}
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">
          {weekday}
          <span
            className="flex items-center gap-1.5"
            style={{ visibility: offset ? undefined : "hidden" }}
          >
            <span className="h-0.5 w-0.5 rounded-full bg-[var(--border-strong)]" aria-hidden />
            {offset ?? "UTC+0"}
          </span>
        </p>
        <p className="mt-0.5 truncate text-[15px] font-semibold tracking-tight">
          {/*
              A shorter date rather than a truncated one.

              "27 August 2026" beside a running clock needs more room than a
              375px phone has here, so it could only ever render as "27 Augu…" —
              a layout that looks broken rather than one that adapted. Both
              spans carry the same styling; only one is ever displayed.
          */}
          <span className="min-[430px]:hidden">{dateShort}</span>
          <span className="hidden min-[430px]:inline">{dateFull}</span>
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3.5">
        <span className="h-8 w-px bg-[var(--border)]" aria-hidden />
        {/*
            One line, one size. The seconds were 15px against a 26px hour and
            minute, which made the clock look like it trailed off. They are the
            same size now and keep only the lighter colour, so the figure reads
            as one number that happens to have a quieter tail.
        */}
        <p
          className="text-[26px] font-semibold leading-none tabular-nums tracking-tight sm:text-[30px]"
          suppressHydrationWarning
          style={{ visibility: live ? undefined : "hidden" }}
        >
          {hhmm}
          <span className="text-faint">:{ss}</span>
        </p>
      </div>
    </div>
  );
}
