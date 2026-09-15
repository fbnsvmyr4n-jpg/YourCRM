"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { bookAction, type BookState } from "./actions";

type Slot = { startsAt: string; endsAt: string };
type Day = { date: string; weekday: number; slots: Slot[] };

/**
 * Pick a day, pick a time, say who you are.
 *
 * Every time is shown in the BUSINESS's zone, with the zone named on screen.
 * The visitor might be anywhere, and a booking page that silently shows the
 * visitor's local time invites the one mistake a booking page exists to
 * prevent: two people agreeing to "10:00" and meaning different hours.
 */
export function BookingView({
  slug,
  workspaceName,
  title,
  kind,
  slotMinutes,
  timeZone,
  days,
  taking,
}: {
  slug: string;
  workspaceName: string;
  title: string;
  kind: "online" | "in_person";
  slotMinutes: number;
  timeZone: string;
  days: Day[];
  taking: boolean;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<BookState, FormData>(bookAction, undefined);
  const [dayIndex, setDayIndex] = useState(0);
  const [picked, setChosen] = useState<string | null>(null);

  /* A slot somebody else took between page load and Book. The choice is cleared
     by DERIVING it — a refused time is simply not selected — rather than by
     setting state from an effect, which would render twice to say one thing.
     The effect only refreshes, so the list stops offering the taken slot. */
  const refused = state && !state.ok && state.taken ? state.startsAt : undefined;
  const chosen = picked && picked === refused ? null : picked;
  useEffect(() => {
    if (refused) router.refresh();
  }, [refused, router]);

  const fmt = useMemo(() => {
    const safe = (opts: Intl.DateTimeFormatOptions) => {
      try {
        return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone });
      } catch {
        return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" });
      }
    };
    return {
      dayShort: safe({ weekday: "short" }),
      dayNum: safe({ day: "numeric", month: "short" }),
      time: safe({ hour: "2-digit", minute: "2-digit", hour12: false }),
      long: safe({ weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false }),
    };
  }, [timeZone]);

  const zoneLabel = timeZone.replace(/_/g, " ");
  const heading = title.trim() || `Book a time with ${workspaceName}`;
  const day = days[Math.min(dayIndex, Math.max(days.length - 1, 0))];

  if (state?.ok) {
    return (
      <Shell>
        <div className="flex flex-col gap-3 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-accent">Booked</p>
          <h1 className="text-2xl font-semibold text-balance">You are in the diary</h1>
          <p className="text-sm text-muted">
            {fmt.long.format(new Date(state.startsAt))} ({zoneLabel}) with {state.workspaceName}.
          </p>
          <p className="text-xs text-faint">
            A confirmation will be emailed to you. If you need to change it, reply to that email.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-faint">{workspaceName}</p>
        <h1 className="text-2xl font-semibold text-balance">{heading}</h1>
        <p className="text-sm text-muted">
          {slotMinutes} minutes · {kind === "online" ? "Online" : "In person"} · times in {zoneLabel}
        </p>
      </header>

      {!taking || days.length === 0 ? (
        <p className="rounded-xl px-4 py-3 text-sm" style={{ background: "var(--panel-solid)" }}>
          {taking
            ? "There are no times available in the coming days. Please check back soon."
            : "This page is not taking bookings at the moment."}
        </p>
      ) : (
        <form action={action} className="flex flex-col gap-5">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="startsAt" value={chosen ?? ""} />

          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Days">
            {days.map((d, i) => {
              const first = new Date(d.slots[0].startsAt);
              const active = i === dayIndex;
              return (
                <button
                  key={d.date}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setDayIndex(i);
                    setChosen(null);
                  }}
                  className="focus-ring flex min-w-[4.5rem] shrink-0 flex-col items-center rounded-xl px-3 py-2 text-sm"
                  style={{
                    background: active ? "var(--accent)" : "var(--panel-solid)",
                    color: active ? "var(--accent-contrast, #fff)" : undefined,
                    /* A border, because in the darkest theme a button's fill is
                       all but the card's own colour and the times read as text. */
                    border: `1px solid ${active ? "var(--accent)" : "var(--border-strong)"}`,
                  }}
                >
                  <span className="text-xs opacity-80">{fmt.dayShort.format(first)}</span>
                  <span className="font-semibold tabular-nums">{fmt.dayNum.format(first)}</span>
                </button>
              );
            })}
          </div>

          {day && (
            <div className="grid grid-cols-3 gap-2 @min-[420px]:grid-cols-4">
              {day.slots.map((s) => {
                const active = chosen === s.startsAt;
                return (
                  <button
                    key={s.startsAt}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setChosen(s.startsAt)}
                    className="focus-ring rounded-lg px-2 py-2 text-sm font-medium tabular-nums"
                    style={{
                      background: active ? "var(--accent)" : "var(--panel-solid)",
                      color: active ? "var(--accent-contrast, #fff)" : undefined,
                    /* A border, because in the darkest theme a button's fill is
                       all but the card's own colour and the times read as text. */
                    border: `1px solid ${active ? "var(--accent)" : "var(--border-strong)"}`,
                    }}
                  >
                    {fmt.time.format(new Date(s.startsAt))}
                  </button>
                );
              })}
            </div>
          )}

          {chosen && (
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">
                {fmt.long.format(new Date(chosen))} <span className="text-faint">({zoneLabel})</span>
              </p>
              <input name="name" required maxLength={80} placeholder="Your name" autoComplete="name" className="field-input" />
              <input name="email" type="email" required maxLength={160} placeholder="Email address" autoComplete="email" className="field-input" />
              <textarea name="notes" maxLength={2000} rows={3} placeholder="Anything we should know (optional)" className="field-input" />
            </div>
          )}

          {state && !state.ok && (
            <p className="rounded-xl px-4 py-3 text-sm" style={{ background: "var(--red-soft)", color: "var(--red)" }} role="alert">
              {state.error}
            </p>
          )}

          <button
            type="submit"
            disabled={!chosen || pending}
            className="btn-accent focus-ring rounded-xl px-5 py-3 text-sm font-semibold disabled:opacity-50"
          >
            {pending ? "Booking…" : chosen ? "Book this time" : "Choose a time"}
          </button>
        </form>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="@container flex min-h-dvh items-start justify-center px-4 py-10 @min-[640px]:items-center">
      <div className="card flex w-full max-w-lg flex-col gap-6 rounded-2xl p-6">{children}</div>
    </main>
  );
}
