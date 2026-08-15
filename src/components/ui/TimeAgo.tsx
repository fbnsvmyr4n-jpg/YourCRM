"use client";

import { useSyncExternalStore } from "react";

/**
 * A timestamp rendered as "2 hours ago · 14:32, 8 Aug", and kept current.
 *
 * Activity dates used to be stored as finished strings, so they were wrong the
 * moment anything moved. Here the stored value is an instant and both halves of
 * the label are derived from it — the relative half re-derives on a timer, so
 * "just now" becomes "5 minutes ago" while the page sits open.
 *
 * Same server/client split as `LiveClock`: the server snapshot is null because
 * the two can be in different time zones, and rendering the server's idea of
 * local time would both mismatch on hydration and mislead.
 */

/**
 * The shared "now" every timestamp on the page measures against.
 *
 * Cached in a module variable rather than read during render: `getSnapshot`
 * must return the same value until it genuinely changes, or React re-renders
 * forever — and reading the clock mid-render is impure besides.
 *
 * It must also be the *real* instant, not a rounded one. Flooring it to the
 * minute put the start of the current minute before anything logged during it,
 * so an event from ten seconds ago rendered as "shortly" — in the future.
 */
let now = Date.now();

function subscribe(onChange: () => void): () => void {
  // Refresh on mount too: the module may have loaded long before this
  // component appeared, leaving `now` stale on its first paint.
  now = Date.now();
  const interval = setInterval(() => {
    now = Date.now();
    onChange();
  }, 30_000);
  return () => clearInterval(interval);
}

function getSnapshot(): number {
  return now;
}

function getServerSnapshot(): number | null {
  return null;
}

export function relativeLabel(at: string, nowMs: number): string {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return "";

  const diff = Math.round((nowMs - then) / 1000);
  const future = diff < 0;
  const s = Math.abs(diff);

  const say = (n: number, unit: string) => {
    const plural = `${n} ${unit}${n === 1 ? "" : "s"}`;
    return future ? `in ${plural}` : `${plural} ago`;
  };

  if (s < 45) return future ? "shortly" : "just now";
  if (s < 3600) return say(Math.round(s / 60), "minute");
  if (s < 86400) return say(Math.round(s / 3600), "hour");
  if (s < 2592000) return say(Math.round(s / 86400), "day");
  if (s < 31536000) return say(Math.round(s / 2592000), "month");
  return say(Math.round(s / 31536000), "year");
}

function absoluteLabel(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  });
}

export function TimeAgo({
  at,
  className,
  /**
   * `relative` for dense lists, where the full stamp wraps onto three lines and
   * shoves the subject out of the row. `both` where there is room for the exact
   * time as well.
   */
  mode = "both",
}: {
  at: string;
  className?: string;
  mode?: "relative" | "both";
}) {
  const nowMs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Nothing real before hydration. `toLocaleString` resolves against the
  // *server's* time zone during SSR, so rendering it would show a time that is
  // simply wrong for the reader — by hours — until React caught up. A hidden
  // placeholder holds the width so the row doesn't jump.
  if (nowMs === null) {
    return (
      <span className={className} style={{ visibility: "hidden" }} aria-hidden>
        {mode === "relative" ? "just now" : "just now · 00:00, 1 Jan"}
      </span>
    );
  }

  const relative = relativeLabel(at, nowMs);
  const absolute = absoluteLabel(at);

  return (
    <span
      className={className}
      suppressHydrationWarning
      // The exact time stays reachable on hover when only the relative half fits.
      title={mode === "relative" ? absolute : undefined}
    >
      {mode === "relative" ? relative : `${relative} · ${absolute}`}
    </span>
  );
}
