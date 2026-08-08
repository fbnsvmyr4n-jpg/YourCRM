"use server";

import { revalidateApp } from "@/server/revalidate";
import { STAGE_IDS, type StageId } from "@/data/deals";
import { createDeal, deleteDeal, moveDeal } from "@/server/deals-repo";
import { id as validId, money, pick, text } from "@/server/validate";

export async function addDealAction(formData: FormData) {
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
  // Both arguments come straight off the wire — the parameter types are erased.
  const dealId = validId(id);
  const target = pick(stage, STAGE_IDS);
  if (!dealId || !target) return;

  await moveDeal(dealId, target);
  revalidateApp();
}

export async function deleteDealAction(id: string) {
  const dealId = validId(id);
  if (!dealId) return;

  await deleteDeal(dealId);
  revalidateApp();
}
