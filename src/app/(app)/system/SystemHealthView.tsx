"use client";

import { useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Hourglass, RotateCw, X } from "lucide-react";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { useKeptForm } from "@/lib/use-kept-form";
import { useCanRunOps } from "@/components/shell/Abilities";
import { discardJobAction, retryJobAction } from "./actions";
import type { FormState } from "@/app/(app)/settings/actions";

/** One failed delivery, as the page hands it over. */
export type StuckRow = {
  id: string;
  /** What it was, in words — see `src/data/jobs.ts`. */
  label: string;
  attempts: number;
  lastError: string | null;
  settledAt: string | null;
  discardedAt: string | null;
};

/**
 * Is this thing working, and if not, what do I press?
 *
 * ── The screen the IT role did not have ───────────────────────────────────
 *
 * `canAccessOps` existed and was read in exactly one place: to decide whether
 * to fill the notification bell. So an admin was correctly told "1 quotation
 * could not be emailed" and the notification linked to /chat — a page their own
 * tier redirects them away from. Every single ops notification did this. The
 * bell's whole premise, written at the top of `notifications.ts`, is that an
 * entry is "a way *into* the work, not just a report that work exists", and for
 * this role it was a wall every time.
 *
 * Driven as an admin, the product was: two sidebar rows, a red badge that never
 * cleared, and nothing to press. The capability existed and was unreachable —
 * exactly what had just been found and fixed for finance, in a different place.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 *
 * The payload. A failed send names what KIND of thing it was and the reason the
 * provider gave, never who it was to or what it said. That is the promise the
 * whole operations tier rests on: an admin can fix the machine without reading
 * one customer's correspondence, and the moment this screen shows a recipient
 * to make a row more useful, the tier stops meaning anything.
 */
export function SystemHealthView({
  stuck,
  waiting,
  automations,
}: {
  stuck: StuckRow[];
  /** Jobs queued and not yet run. A number, not a guess. */
  waiting: number;
  /** Rules that have stopped working, and the latest reason given. */
  automations: { count: number; latest: string | null };
}) {
  /* Asked of the shell rather than taken as a prop, like every other screen's
     write check — one answer per door, decided once from the role. */
  const canAct = useCanRunOps();
  const retry = useKeptForm<FormState>(retryJobAction, undefined);
  const discard = useKeptForm<FormState>(discardJobAction, undefined);
  const [confirming, setConfirming] = useState<string | null>(null);

  const needsAttention = stuck.filter((j) => !j.discardedAt);
  const judged = stuck.filter((j) => j.discardedAt);

  return (
    <div className="mx-auto max-w-[900px] animate-fade-up">
      <div className="flex flex-wrap items-end justify-between gap-3 pb-4 pt-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">System health</h1>
          <p className="mt-1 text-sm text-muted">
            What this workspace tried to send and could not, and what is still waiting.
          </p>
        </div>
      </div>

      <Card className="mb-4">
        <CardHeader
          title="Failed deliveries"
          icon={
            needsAttention.length > 0 ? (
              <AlertTriangle className="h-[18px] w-[18px] text-red" />
            ) : (
              <CheckCircle2 className="h-[18px] w-[18px] text-accent" />
            )
          }
          action={
            needsAttention.length > 0 ? (
              <CardMeta value={needsAttention.length}>
                {needsAttention.length === 1 ? "needs a look" : "need a look"}
              </CardMeta>
            ) : undefined
          }
        />

        {retry.state && <Banner state={retry.state} />}
        {discard.state && <Banner state={discard.state} />}

        {needsAttention.length === 0 ? (
          <p className="text-sm text-faint">
            {/* Said as a fact about the queue, not as praise. "All good!" on a
                workspace that has sent nothing all week is a reassurance the
                screen has not earned.

                And it has to agree with what is directly beneath it: "nothing
                has been given up on" printed above a list headed "Stopped on
                purpose (1)" is the screen contradicting itself in the space of
                two lines, which is how a reader decides neither sentence is
                worth reading. */}
            {judged.length > 0
              ? "Nothing is waiting on you. What was stopped on purpose is below, with its reason."
              : "Nothing has been given up on. Anything that fails is retried on a ladder first, and only lands here once that has run out."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {needsAttention.map((job) => (
              <li
                key={job.id}
                className="rounded-xl px-3.5 py-3"
                style={{ background: "var(--surface-2)" }}
              >
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-sm font-medium">{job.label}</span>
                    <span className="block text-xs text-faint">
                      {job.attempts} {job.attempts === 1 ? "attempt" : "attempts"}
                      {job.settledAt && (
                        <>
                          {" · gave up "}
                          <TimeAgo at={job.settledAt} mode="relative" />
                        </>
                      )}
                    </span>
                  </span>

                  {canAct &&
                    (confirming === job.id ? (
                      <form
                        onSubmit={discard.onSubmit}
                        className="flex shrink-0 items-center gap-1.5"
                      >
                        <input type="hidden" name="id" value={job.id} />
                        <span className="text-xs text-muted">Stop trying this one?</span>
                        <button
                          type="submit"
                          disabled={discard.pending}
                          className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-60"
                          style={{ background: "var(--red-soft)", color: "var(--red)" }}
                        >
                          Stop trying
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(null)}
                          className="focus-ring rounded-lg px-2 py-1.5 text-xs font-medium text-muted"
                        >
                          Keep
                        </button>
                      </form>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <form onSubmit={retry.onSubmit}>
                          <input type="hidden" name="id" value={job.id} />
                          <button
                            type="submit"
                            disabled={retry.pending}
                            className="btn-accent focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                          >
                            <RotateCw className="h-3.5 w-3.5" />
                            {retry.pending ? "Trying…" : "Try again"}
                          </button>
                        </form>
                        <button
                          type="button"
                          onClick={() => setConfirming(job.id)}
                          aria-label={`Stop trying ${job.label}`}
                          className="btn-soft focus-ring rounded-lg p-2 text-muted transition-colors hover:text-red"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </span>
                    ))}
                </div>

                {/*
                   The provider's own words, carried through rather than
                   softened. "The resend.dev domain can only send to the account
                   owner" tells somebody exactly what to fix; "something went
                   wrong" sends them to a search engine.
                */}
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  {job.lastError ?? "No reason was recorded."}
                </p>
              </li>
            ))}
          </ul>
        )}

        {judged.length > 0 && (
          <div className="mt-4 border-t border-[var(--border)] pt-3">
            <p className="mb-2 text-xs font-medium text-muted">
              Stopped on purpose ({judged.length})
            </p>
            <ul className="flex flex-col gap-1">
              {judged.map((job) => (
                <li key={job.id} className="flex flex-wrap items-baseline gap-x-2 text-xs text-faint">
                  <span className="font-medium">{job.label}</span>
                  <span>·</span>
                  {/* The row is kept and so is the reason. A failure somebody
                      decided against is a decision, and a decision nobody can
                      look up is a decision nobody can question. */}
                  <span className="min-w-0 flex-1 truncate">
                    {job.lastError ?? "no reason was recorded"}
                  </span>
                  {job.discardedAt && <TimeAgo at={job.discardedAt} mode="relative" />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/*
         Shown only when one has stopped.

         A card reading "0 automations are failing" on every visit is a card
         people stop seeing, and this screen's whole value is that something
         appearing on it means something. The queue card below earns its
         permanent place differently: zero waiting is itself the answer to "is
         the queue moving".
      */}
      {automations.count > 0 && (
        <Card className="mb-4">
          <CardHeader
            title="Automations that stopped"
            icon={<AlertTriangle className="h-[18px] w-[18px] text-red" />}
            action={
              <CardMeta value={automations.count}>
                {automations.count === 1 ? "rule" : "rules"}
              </CardMeta>
            }
          />
          <p className="text-sm text-muted">{automations.latest ?? "No reason was recorded."}</p>
          {/* Said rather than linked. The rules are configured on a screen that
              shows leads and deals, which this reader's tier keeps them out of
              — so a link here would be the same dead end this page exists to
              remove. Naming who can fix it is the useful thing instead. */}
          <p className="mt-2 text-xs text-faint">
            The rules themselves are set up under Settings by somebody who works
            with the pipeline, because a rule decides whose desk a new lead lands on.
          </p>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Waiting to send"
          icon={<Hourglass className="h-[18px] w-[18px] text-accent" />}
          action={<CardMeta value={waiting}>{waiting === 1 ? "job" : "jobs"}</CardMeta>}
        />
        <p className="text-sm text-faint">
          {waiting === 0
            ? "The queue is empty. Work is normally run by the request that creates it, so a lasting number here is the thing to watch, not a brief one."
            : "Queued and not yet run. These are retried on a ladder; anything that runs out of road appears above."}
        </p>
      </Card>

      <p className="mt-4 flex items-start gap-2 px-1 text-xs leading-relaxed text-faint">
        <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {/* Said once, plainly, because somebody looking at a list of failed
            sends will wonder what else they can see — and the honest answer is
            the reason this screen is allowed to exist at all. */}
        This screen shows what the system tried to do and why it stopped. It
        never shows who a message was for or what it said.
      </p>
    </div>
  );
}
