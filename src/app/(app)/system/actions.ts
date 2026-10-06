"use server";

import { revalidatePath } from "next/cache";
import { discardJob, jobStatus, retryJob } from "@/server/repos/outbox";
import { drain } from "@/server/outbox";
import { OUTBOX_REGISTRY } from "@/server/outbox-handlers";
import { requireTenant, withCurrentTenant } from "@/server/tenant-session";
import { text } from "@/server/validate";
import { refused } from "@/server/write-result";
import type { FormState } from "@/app/(app)/settings/actions";

/**
 * What an IT admin can actually DO about a failed delivery.
 *
 * `withOps` is `withCurrentTenant` with the operations door fixed — named once
 * here rather than repeated at each call site, for the same reason `withMail`
 * and `withMoney` are: repeated is how one of them ends up without it, and that
 * one would be the action the role exists to press.
 */
const withOps = <T>(fn: Parameters<typeof withCurrentTenant<T>>[0]) =>
  withCurrentTenant(fn, { ops: true });

/**
 * Put a job the system gave up on back in the queue.
 *
 * ── Why this is IT's to press, and not only the salesperson's ─────────────
 *
 * Worth stating, because "re-send a client's quotation" sounds like sales. It
 * is not: the decision to send was made by whoever pressed Approve, and it
 * still stands. What failed was the delivery; the cause is almost always
 * something only IT can fix — an unverified mail domain, a provider key, a
 * bounced address — and the person who fixed it is the one who knows the moment
 * it is worth trying again.
 *
 * The alternative is what this product does today: the salesperson is never
 * told it failed, the admin is told and cannot act, and the client waits.
 *
 * Nothing new is composed here. This re-runs an instruction a person already
 * gave, which is why it needs no sight of what the document says.
 */
export async function retryJobAction(_prev: FormState, formData: FormData): Promise<FormState> {
  // The guard is the FIRST statement, before the form is even read. The ctx it
  // returns is needed below anyway, to drain outside the gate's transaction.
  const ctx = await requireTenant();

  const id = text(formData.get("id"), 64);
  if (!id) return { error: "That job could not be identified." };

  const revived = await withOps((q) => retryJob(q, id));
  /* The gate answers `{ error }` for a reader it refuses, whatever the action
     says it returns — so the answer is checked before it is believed. */
  if (refused(revived)) return revived;
  if (!revived) {
    /* Said plainly rather than pretended. Somebody else has retried it, or it
       is already running — and "Queued" over a job that is not queued is the
       small kind of lie that costs a reader their trust in the screen. */
    return { error: "That job is no longer waiting to be retried." };
  }

  /*
     Run it NOW rather than waiting for the sweep.

     Somebody who has just fixed a mail domain and pressed Try again is asking a
     question — did that work? — and an answer that arrives on a cron's schedule
     is not an answer. Drained OUTSIDE the gate's transaction, like every other
     caller: the handler talks to a mail provider, and holding a connection and
     a row lock while it does is what deadlocks a pool one connection deep.
  */
  await drain(ctx, OUTBOX_REGISTRY, 5).catch(() => {});

  const after = await withOps((q) => jobStatus(q, id));
  revalidatePath("/system");
  if (refused(after)) return after;

  /* Three different truths, and the reader is owed the right one. "We'll keep
     trying" about a job that has already stopped again is worse than silence. */
  if (after?.status === "done") return { ok: "Sent." };
  if (after?.status === "dead") {
    return { error: `It failed again: ${after.lastError ?? "no reason was recorded"}` };
  }
  return { ok: "Queued. It will go out on the next run." };
}

/**
 * Decide a failure is not going to be fixed.
 *
 * The record is kept and so is the reason — all that changes is that somebody
 * named has looked at it. That is the only honest way for the bell to go quiet:
 * the alternative is a count nobody can clear, which is a count everybody
 * learns to ignore, and then the next real failure is invisible too.
 */
export async function discardJobAction(_prev: FormState, formData: FormData): Promise<FormState> {
  // The gate first, and the form read inside it — so there is no arrangement
  // of this function that touches the request before knowing who is asking.
  return withOps(async (q) => {
    const id = text(formData.get("id"), 64);
    if (!id) return { error: "That job could not be identified." };

    const done = await discardJob(q, id, q.ctx.userId);
    if (!done) return { error: "That job has already been dealt with." };
    revalidatePath("/system");
    return { ok: "Stopped. It stays on this screen, with its reason." };
  });
}
