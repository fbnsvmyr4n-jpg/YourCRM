"use client";

import { useSyncExternalStore } from "react";

/**
 * What time it is *where the client is*.
 *
 * The panel used to print a stored string ("16 May 2024, 10:31 AM") labelled
 * "Local Time" — a literal that had nothing to do with any clock and never
 * changed. This computes the real current time in the contact's own zone, which
 * is the only version of that field worth having: it answers "is this a
 * reasonable hour to call them?"
 *
 * Same server/client split as `LiveClock` — the server renders nothing, because
 * it would be computing against its own idea of now.
 */

let now = Date.now();

function subscribe(onChange: () => void): () => void {
  now = Date.now();
  // Aligned to the next minute so the display flips when their clock does.
  let interval: ReturnType<typeof setInterval>;
  const align = setTimeout(() => {
    now = Date.now();
    onChange();
    interval = setInterval(() => {
      now = Date.now();
      onChange();
    }, 60_000);
  }, 60_000 - (Date.now() % 60_000));

  return () => {
    clearTimeout(align);
    clearInterval(interval);
  };
}

function getSnapshot(): number {
  return now;
}

function getServerSnapshot(): number | null {
  return null;
}

/** Their offset from the reader's own clock, e.g. "1 hour behind you". */
export function offsetLabel(timeZone: string, nowMs: number): string | null {
  try {
    const there = new Date(nowMs).toLocaleString("en-US", { timeZone });
    const here = new Date(nowMs).toLocaleString("en-US");
    const diffMin = Math.round((Date.parse(there) - Date.parse(here)) / 60_000);

    if (diffMin === 0) return "same time as you";

    const hours = Math.floor(Math.abs(diffMin) / 60);
    const mins = Math.abs(diffMin) % 60;
    const span = [hours ? `${hours} hour${hours === 1 ? "" : "s"}` : null, mins ? `${mins} min` : null]
      .filter(Boolean)
      .join(" ");

    return `${span} ${diffMin > 0 ? "ahead of" : "behind"} you`;
  } catch {
    return null;
  }
}

export function ClientClock({ timeZone, className }: { timeZone: string; className?: string }) {
  const nowMs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (nowMs === null) {
    return (
      <span className={className} style={{ visibility: "hidden" }} aria-hidden>
        Mon, 1 Jan, 00:00
      </span>
    );
  }

  let stamp: string;
  try {
    stamp = new Date(nowMs).toLocaleString(undefined, {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    // An unknown zone must not take the panel down with it.
    return <span className={className}>Unknown time zone</span>;
  }

  const offset = offsetLabel(timeZone, nowMs);

  return (
    <span className={className} suppressHydrationWarning>
      {stamp}
      {offset && <span className="text-faint"> · {offset}</span>}
    </span>
  );
}
