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
    /* Tighter gutters and gaps below 380, and only below 380.

       Claiming the free space fixed a 393px phone but not a 320px one — with
       Display Zoom on, the block gets 103px against a worst case of 143. The
       clock is deliberately untouched, so the width has to come from the
       spacing around it: 4px of card padding each side, 8 off the gap between
       the halves, and 4 off the gap around the divider. Twenty pixels, none of
       which is doing visible work at that size. */
    <div className="card flex items-center justify-between gap-2 px-4 py-4 min-[380px]:gap-4 min-[380px]:px-5">
      {/*
          `flex-1`, and that is the whole fix for the cut-off year.

          This block was `min-w-0` with no grow, so it sized to its content and
          `truncate` then clipped it at whatever that came to. Measured on a
          393px phone: the block was 125px wide while 178px was actually free —
          53px of the card sat unused between the two halves, because
          `justify-between` pushed the slack into the gap rather than giving it
          to the text that needed it.

          At 125px "31 Aug 2026" fits in Chrome with nothing to spare and
          overflows in Safari, whose metrics for the same string are a hair
          wider — which is exactly the reported "31 Aug 2…" on a real iPhone
          against a clean render here.

          And August is one of the SHORT months. Measured across all twelve at
          22px, the widest is "28 Sept 2026" at 143px: eighteen pixels past the
          old 125, so this would have truncated on every phone from September
          onward, not just this one. With the space claimed the block is 178px
          and the worst case has 35px to spare.
      */}
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">
          {weekday}
        </p>
        {/*
            Scaled to sit beside the clock, not beneath it.

            At 15px against a 34px time this line read as a caption on the
            figure to its right rather than the other half of a pair — the two
            sides of the card were two different type sizes with nothing
            relating them. It takes the clock's treatment one step down: the
            same weight (500), the same negative tracking, at 22/26px against
            the clock's 30/34. Close enough to belong to it, far enough that the
            time is still the thing the eye lands on.

            Deliberately NOT the clock's exact size. Two 34px figures either
            side of a hairline would read as a split card with no subject.
        */}
        {/* 18px below 360, and only below 360.

            Twenty pixels of tighter spacing was not enough on its own — at
            320 the worst case still needed 143 against 123 — so the date takes
            one more step down where the card is genuinely out of room. It is
            the smaller half of the pair there rather than the equal it is
            higher up, which is the right way round when the alternative is a
            year that is not there.

            360 rather than 380 because the available width tracks the viewport
            almost exactly: 123px at 320 and 178 at 375. At 360 there is 163 for
            a 143px worst case, so 22px already fits with room. Stepping down at
            380 shrank the date on a 375px phone that had 61px to spare. */}
        <p className="mt-1 truncate text-[18px] font-medium leading-none tracking-[-0.02em] min-[360px]:text-[22px] sm:text-[26px]">
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

      <div className="flex shrink-0 items-center gap-3 min-[380px]:gap-4">
        {/*
            A hairline that fades out at both ends rather than stopping dead.

            A flat rule butting into the card's padding draws attention to
            itself; this one is only fully present where it is separating
            something, which is the detail that stops a divider reading as a
            border somebody forgot to remove.
        */}
        <span
          className="h-9 w-px shrink-0"
          style={{
            background:
              "linear-gradient(to bottom, transparent, var(--border) 22%, var(--border) 78%, transparent)",
          }}
          aria-hidden
        />
        <div className="text-right">
          <p
            /*
               Larger, and a step LIGHTER.

               At display sizes a semibold clock reads as heavy rather than
               confident — the weight that makes 15px legible is the weight that
               makes 34px shout. Dropping to 500 and pulling the tracking in
               slightly is the treatment a system typeface gets at this size,
               and it lets the figure grow without dominating the card.
            */
            className="text-[30px] font-medium leading-none tabular-nums tracking-[-0.02em] sm:text-[34px]"
            suppressHydrationWarning
            style={{ visibility: live ? undefined : "hidden" }}
          >
            {hhmm}
            {/* Smaller and lighter: the seconds are the least useful part of a
                glanceable clock, but removing them makes it look frozen. */}
            <span className="text-[16px] font-normal text-faint sm:text-[18px]">:{ss}</span>
          </p>
          <p
            className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint"
            style={{ visibility: offset ? undefined : "hidden" }}
          >
            {offset ?? "UTC+0"}
          </p>
        </div>
      </div>
    </div>
  );
}
