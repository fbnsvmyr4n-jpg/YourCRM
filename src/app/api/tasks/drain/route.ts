import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { sweep } from "@/server/outbox-drain";

export const dynamic = "force-dynamic";
/**
 * Long enough for a sweep, short of the platform's own ceiling.
 *
 * A sweep that is killed mid-flight is not a disaster — the jobs it was
 * holding stay leased and become due again — but it is wasted work and a
 * confusing log, so the bound is stated here rather than discovered.
 */
export const maxDuration = 60;

/**
 * The scheduled drain.
 *
 * Almost every job is run by the request that queued it, seconds later. This
 * endpoint exists for the rest: the send that failed while the provider was
 * restarting, the analysis whose serverless invocation was frozen, the
 * workspace whose email was switched on this afternoon. Without something on a
 * schedule, `run_after` is a promise nothing keeps.
 *
 * Serverless is why this is an HTTP endpoint rather than a worker: there is no
 * process to leave running. Anything that can make an authenticated request
 * can drive it — a scheduler, or a person with the secret when something needs
 * pushing along.
 *
 * ── Nothing schedules this yet, and that is deliberate ───────────────────
 *
 * A `vercel.json` declaring a cron shipped with this endpoint and production
 * stopped deploying at that exact commit — two pushes built nothing, while the
 * commit before it, which had no such file, had deployed cleanly. It was
 * removed rather than debugged blind, because the cron was doing nothing
 * anyway: without `CRON_SECRET` set in the project, Vercel's own trigger gets
 * the 401 below.
 *
 * So the retry ladder currently rests on the opportunistic drains — every
 * place that queues a job also drains it in the same request — and this
 * endpoint waits for a scheduler. To connect one: set `CRON_SECRET`, then
 * either add `vercel.json` back (Pro plan; Hobby triggers crons once a day
 * whatever the expression says) or point any external scheduler at
 * `POST /api/tasks/drain` with `Authorization: Bearer $CRON_SECRET`.
 *
 * ── Authentication ───────────────────────────────────────────────────────
 *
 * The URL is public, so the secret is the whole of the protection. Without
 * `CRON_SECRET` set the endpoint REFUSES rather than running openly: an
 * unauthenticated drain is an unauthenticated way to make the platform send
 * every queued email on demand, and defaulting to open would make forgetting
 * one environment variable indistinguishable from configuring it.
 */
function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  /* Length first, then a constant-time compare — `timingSafeEqual` throws on a
     length mismatch, and comparing with `===` would leak the secret's length
     and prefix to anyone willing to time the responses. */
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!authorised(req)) {
    /* Deliberately identical whether the secret is wrong or unset. Which of
       the two it is tells an unauthenticated caller something about this
       deployment's configuration, and they have no business knowing it. */
    return new NextResponse("Not authorised", { status: 401 });
  }

  const report = await sweep();
  /* Counts only. What was in the queue is between the workspace and its own
     screens; this answers "did the sweep run and did anything fail", which is
     what a scheduler and a person checking on it need. */
  return NextResponse.json(report);
}

/**
 * Vercel Cron issues a GET, so the two verbs do the same thing.
 *
 * A drain is not idempotent in the strict sense — it has effects — but it is
 * safe to repeat: each job is leased before it runs and settled after, so two
 * sweeps arriving together divide the work rather than duplicating it.
 */
export const GET = POST;
