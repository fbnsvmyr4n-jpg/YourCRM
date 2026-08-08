"use client";

import { useSyncExternalStore } from "react";

/**
 * The current time, ticking.
 *
 * The wall clock is an external mutable source, so this uses
 * `useSyncExternalStore` rather than an effect writing state — that is exactly
 * what the hook exists for, and it keeps the server and client snapshots
 * explicitly separate.
 *
 * The server snapshot is `null` on purpose. The server and the browser can sit
 * in different time zones, so rendering a real time during SSR would both
 * cause a hydration mismatch and, worse, briefly show the *server's* idea of
 * the time on a dashboard people will read at a glance.
 */

function subscribe(onChange: () => void): () => void {
  // Aligned to the next whole second so the display flips when the user's own
  // clock does, not up to a second late.
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
function getSnapshot(): number {
  return Math.floor(Date.now() / 1000);
}

function getServerSnapshot(): number | null {
  return null;
}

export function LiveClock({ className }: { className?: string }) {
  const seconds = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Reserve the width before hydration so the header doesn't shift.
  if (seconds === null) {
    return (
      <span className={className} style={{ visibility: "hidden" }} aria-hidden>
        00:00:00
      </span>
    );
  }

  return (
    <span className={className} suppressHydrationWarning>
      {new Date(seconds * 1000).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}
    </span>
  );
}
