"use server";

import { revalidateApp } from "@/server/revalidate";
import {
  addPainPoints,
  removePainPoint,
  assignOwner,
  createDeal,
  deleteDeal,
  getDeal,
  moveStage,
  recordPayment,
  restoreDeal,
  updateDeal,
  SOURCES,
  STAGES,
  type Stage,
} from "@/server/repos/deals";
import { logActivity } from "@/server/repos/activity";
import { recordReferral } from "@/server/referrals";
import { withCurrentTenant } from "@/server/tenant-session";
import { id as validId, money, multiline, pick, text } from "@/server/validate";
import { logWrite } from "@/server/log";

/**
 * Deal actions, on the real pipeline.
 *
 * Money crosses this boundary in whole currency units, because that is what a
 * person types into a form, and is converted to integer cents once — here, at
 * the edge. Converting in two places is how a figure ends up 100× wrong, and
 * converting in none is how it ends up 100× small.
 */
const toCents = (units: number) => Math.round(units * 100);

export async function addDealAction(formData: FormData) {
  return withCurrentTenant(async (q) => {
    const title = text(formData.get("title"), 120);
    const stage = pick(formData.get("stage"), STAGES);
    const source = pick(formData.get("source"), SOURCES);
    const value = money(formData.get("value"));

    // A deal with no title is unusable, an unknown stage would render in no
    // column at all, and a non-numeric value turns every total into NaN.
    if (!title || !stage || value === null) return;

    const created = await createDeal(q, {
      title,
      contactId: validId(String(formData.get("contactId") ?? "")) || null,
      valueCents: toCents(value),
      stage,
      source: source ?? "other",
      ownerUserId: q.ctx.userId,
    });

    await logActivity(q, {
      entityType: "deal",
      entityId: created.id,
      kind: "created",
      title: `Deal created — ${created.title}`,
      amountCents: created.valueCents,
      actorUserId: q.ctx.userId,
    });

    revalidateApp();
    return created.id;
  });
}

/**
 * Move a deal along the pipeline.
 *
 * Goes through `moveStage`, never a field assignment, because the move carries
 * side effects: it stamps `won_at` on the close, preserves it through Delivery
 * and Referral, and clears it if the deal comes back before the close. A plain
 * update would leave the row disagreeing with itself.
 */
export async function moveDealAction(id: string, stage: Stage, lostReason?: string) {
  return withCurrentTenant(async (q) => {
    // Both arguments come straight off the wire — parameter types are erased.
    const dealId = validId(id);
    const target = pick(stage, STAGES);
    if (!dealId || !target) return { error: "That move is not valid." };

    if (target === "lost") {
      const reason = text(lostReason ?? "", 200);
      // Refused rather than defaulted: a loss analysis built from whichever
      // losses somebody happened to annotate is worse than none.
      if (!reason) return { error: "A lost deal needs a reason." };
      const moved = await moveStage(q, dealId, "lost", { lostReason: reason });
      if (!moved) return { error: "That deal no longer exists." };

      await logActivity(q, {
        entityType: "deal",
        entityId: dealId,
        kind: "lost",
        title: "Deal lost",
        detail: reason,
        actorUserId: q.ctx.userId,
      });
      revalidateApp();
      return { ok: true as const };
    }

    const before = await getDeal(q, dealId);
    const moved = await moveStage(q, dealId, target);
    if (!moved) return { error: "That deal no longer exists." };

    if (before && before.stage !== target) {
      await logActivity(q, {
        entityType: "deal",
        entityId: dealId,
        kind: target === "won" && !before.wonAt ? "won" : "stage_change",
        title: `Moved to ${target}`,
        detail: `from ${before.stage}`,
        amountCents: target === "won" ? moved.valueCents : undefined,
        actorUserId: q.ctx.userId,
      });
    }

    revalidateApp();
    return { ok: true as const };
  });
}

/** Attach a figure once a real quote exists. */
export async function setDealValueAction(id: string, formData: FormData) {
  return withCurrentTenant(async (q) => {
    const dealId = validId(id);
    const value = money(formData.get("value"));
    if (!dealId || value === null) return { error: "Enter a valid amount." };

    const updated = await updateDeal(q, dealId, { valueCents: toCents(value) });
    if (!updated) return { error: "That deal no longer exists." };
    revalidateApp();
    return { ok: true as const };
  });
}

/**
 * Record what the prospect said hurts.
 *
 * The mechanic at the centre of the process: what is captured in Discovery is
 * the input to the Demo, so the presentation is driven by what they actually
 * said rather than a feature tour. Appended in SQL, so two people finishing
 * calls on the same deal cannot erase each other.
 */
export async function addPainPointsAction(id: string, formData: FormData) {
  return withCurrentTenant(async (q) => {
    const dealId = validId(id);
    const raw = multiline(formData.get("painPoints"), 2000);
    if (!dealId || !raw) return { error: "Nothing to add." };

    // One per line, which is how someone types notes during a call.
    const points = raw.split("\n").map((p) => p.trim()).filter(Boolean).slice(0, 20);
    if (points.length === 0) return { error: "Nothing to add." };

    const updated = await addPainPoints(q, dealId, points);
    if (!updated) return { error: "That deal no longer exists." };

    await logActivity(q, {
      entityType: "deal",
      entityId: dealId,
      kind: "note",
      title: points.length === 1 ? "Pain point captured" : `${points.length} pain points captured`,
      detail: points.join(" · "),
      actorUserId: q.ctx.userId,
    });

    revalidateApp();
    return { ok: true as const, painPoints: updated.painPoints };
  });
}

/**
 * Record money received against a deal awaiting payment.
 *
 * Validated here AND re-checked inside the repository against the deal as
 * stored — a server action's arguments are as forgeable as any form field, and
 * this one moves money between columns.
 */
/**
 * Record a referral: a new prospect, attributed to whoever sent them.
 *
 * The Referral stage's exit condition is "Feeds back into Prospect", and
 * nothing made that happen — the cycle ran in somebody's head, or more usually
 * did not run at all.
 *
 * One transaction, because the person and the opportunity must not half-exist:
 * a contact with no deal is a name nobody follows up, and a deal with no
 * contact is a card with nobody to call.
 */
export async function recordReferralAction(fromDealId: string, formData: FormData) {
  return withCurrentTenant(async (q) => {
    const dealId = validId(fromDealId);
    if (!dealId) return { error: "Deal not found." };

    // The referrer is taken from the deal being viewed, not from the form. A
    // form field would be an id the browser controls, and attributing a
    // referral to an arbitrary contact is how a reward programme gets gamed.
    const deal = await getDeal(q, dealId);
    if (!deal?.contactId) {
      return { error: "This deal has no contact, so there is nobody to credit." };
    }

    const firstName = text(formData.get("firstName"), 80);
    const lastName = text(formData.get("lastName"), 80);
    const email = text(formData.get("email"), 160);
    const phone = text(formData.get("phone"), 40);
    const note = multiline(formData.get("note"), 500);

    if (!firstName && !lastName) return { error: "Give the person a name." };

    const result = await recordReferral(q, {
      referrerContactId: deal.contactId,
      firstName: firstName ?? "",
      lastName: lastName ?? "",
      email,
      phone,
      note,
    });
    if (!result.ok) return { error: result.error };

    revalidateApp();
    return { ok: true as const, dealId: result.deal.id };
  });
}

export async function removePainPointAction(id: string, point: string) {
  return withCurrentTenant(async (q) => {
    const dealId = validId(id);
    const text = multiline(point, 500);
    if (!dealId || !text) return { error: "Nothing to remove." };

    const updated = await removePainPoint(q, dealId, text);
    if (!updated) return { error: "That deal no longer exists." };

    // Logged like the capture is. A pain point disappearing from the demo
    // without a trace is the kind of thing two people blame each other for.
    await logActivity(q, {
      entityType: "deal",
      entityId: dealId,
      kind: "note",
      title: "Pain point removed",
      detail: text,
      actorUserId: q.ctx.userId,
    });

    revalidateApp();
    return { ok: true as const, painPoints: updated.painPoints };
  });
}

export async function recordPaymentAction(id: string, formData: FormData) {
  return withCurrentTenant(async (q) => {
    const dealId = validId(id);
    if (!dealId) return { error: "Deal not found." };

    const amount = money(formData.get("amount"));
    if (amount === null) return { error: "Enter a valid amount." };

    const result = await recordPayment(q, dealId, toCents(amount));
    if (result.ok) {
      await logActivity(q, {
        entityType: "deal",
        entityId: dealId,
        kind: "won",
        title: "Payment recorded",
        amountCents: toCents(amount),
        actorUserId: q.ctx.userId,
      });
    }
    revalidateApp();
    return result;
  });
}

export async function assignDealAction(id: string, ownerUserId: string | null) {
  return withCurrentTenant(async (q) => {
    const dealId = validId(id);
    if (!dealId) return { error: "That deal is not valid." };
    const owner = ownerUserId ? validId(ownerUserId) : null;
    if (ownerUserId && !owner) return { error: "That person is not valid." };

    const { error } = await assignOwner(q, dealId, owner);
    if (error) return { error };
    revalidateApp();
    return { ok: true as const };
  });
}

/**
 * Says whether the deal actually went.
 *
 * It used to return nothing, and the board removed the card before calling it
 * and never awaited the result. A delete that failed therefore left the card
 * gone from the screen and the deal in the database, until a refresh brought it
 * back with no explanation. The board could not tell success from failure
 * because it was given nothing to tell them apart with.
 */
export async function deleteDealAction(id: string): Promise<boolean> {
  return withCurrentTenant(async (q) => {
    const dealId = validId(id);
    if (!dealId) return false;
    // Soft, and therefore undoable — from Settings → Recently deleted, or
    // `restoreDealAction`.
    const deleted = await deleteDeal(q, dealId);
    if (deleted) {
      logWrite("delete", "deal", { id: dealId, actor: q.ctx.userId });
    }
    revalidateApp();
    return deleted;
  });
}

export async function restoreDealAction(id: string) {
  return withCurrentTenant(async (q) => {
    const dealId = validId(id);
    if (!dealId) return;
    if (await restoreDeal(q, dealId)) {
      logWrite("restore", "deal", { id: dealId, actor: q.ctx.userId });
    }
    revalidateApp();
  });
}
