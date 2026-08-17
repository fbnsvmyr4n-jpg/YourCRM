"use server";

import { revalidateApp } from "@/server/revalidate";
import { STAGE_IDS, type StageId } from "@/data/deals";
import { createDeal, deleteDeal, moveDeal, recordPayment, setDealValue } from "@/server/deals-repo";
import { id as validId, money, pick, text } from "@/server/validate";
import { requireUser } from "@/server/session";
import { logWrite } from "@/server/log";

export async function addDealAction(formData: FormData) {
  await requireUser();
  const title = text(formData.get("title"), 120);
  const stage = pick(formData.get("stage"), STAGE_IDS);
  const value = money(formData.get("value"));

  // A deal with no title is unusable, an unknown stage would render in no
  // column at all, and a non-numeric value turns every pipeline total into NaN.
  if (!title || !stage || value === null) return;

  const created = await createDeal({
    title,
    contact: text(formData.get("contact"), 80),
    company: text(formData.get("company"), 80),
    value,
    stage,
  });
  revalidateApp();
  return created;
}

export async function moveDealAction(id: string, stage: StageId) {
  await requireUser();
  // Both arguments come straight off the wire — the parameter types are erased.
  const dealId = validId(id);
  const target = pick(stage, STAGE_IDS);
  if (!dealId || !target) return;

  await moveDeal(dealId, target);
  revalidateApp();
}

export async function deleteDealAction(id: string) {
  const actor = await requireUser();
  const dealId = validId(id);
  if (!dealId) return;

  await deleteDeal(dealId);

  logWrite("delete", "deal", { id: dealId, actor: actor.id });
  revalidateApp();
}

/** Attach a figure once a real quote exists. */
export async function setDealValueAction(id: string, formData: FormData) {
  await requireUser();
  const dealId = validId(id);
  const value = money(formData.get("value"));
  if (!dealId || value === null) return;

  await setDealValue(dealId, value);
  revalidateApp();
}

/**
 * Record money received against a deal awaiting payment.
 *
 * Validated here *and* re-checked inside the repo against the deal's live
 * value — a server action's arguments are as forgeable as any form field, and
 * this one moves money between columns.
 */
export async function recordPaymentAction(id: string, formData: FormData) {
  await requireUser();
  const dealId = validId(id);
  if (!dealId) return { error: "Deal not found." };

  const amount = money(formData.get("amount"));
  if (amount === null) return { error: "Enter a valid amount." };

  const result = await recordPayment(dealId, amount);
  revalidateApp();
  return result;
}
