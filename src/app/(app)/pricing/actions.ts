"use server";

import {
  deletePriceItem,
  savePriceItem,
  setPriceItemActive,
} from "@/server/repos/pricing";
import { logWrite } from "@/server/log";
import { revalidateApp } from "@/server/revalidate";
import { withCurrentTenant } from "@/server/tenant-session";
import { decimal, id as validId, multiline, text } from "@/server/validate";

/**
 * Maintaining the price list.
 *
 * Customer data by the gate's definition — it is what this business charges,
 * and it is read straight onto quotations — so every action goes through
 * `withCurrentTenant` with no opt-out. IT and accounts are refused by
 * construction.
 */

export type FormState = { ok?: string; error?: string } | undefined;

/** A price ceiling per unit, in whole currency units. */
const MAX_UNIT_PRICE = 100_000_000;

export async function savePriceItemAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const name = text(formData.get("name"), 120);
    if (!name) return { error: "Give the item a name." };

    /*
       `decimal`, not `money`. A rate of $12.50 an hour is ordinary and `money`
       rounds to whole units — the same mistake that shipped a purchase order
       line at 4 days instead of 3.5. Two decimal places, then converted to
       cents once.
    */
    const price = decimal(formData.get("unitPrice"), MAX_UNIT_PRICE, 2);
    if (price === null) return { error: "That price could not be read as a number." };

    const result = await savePriceItem(q, {
      id: validId(formData.get("id")) ?? null,
      name,
      description: multiline(formData.get("description"), 400),
      unit: text(formData.get("unit"), 40),
      unitCents: Math.round(price * 100),
    });
    if (result.error) return { error: result.error };

    revalidateApp();
    return { ok: `${result.item?.name} saved.` };
  });
}

/**
 * Withdraw an item, or bring it back.
 *
 * Withdrawing rather than deleting: a quotation that cited this line last year
 * has to keep making sense, and the only way to guarantee that is to leave the
 * row alone.
 */
export async function togglePriceItemAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const itemId = validId(formData.get("id"));
    if (!itemId) return { error: "That item could not be identified." };
    const active = formData.get("active") === "true";

    const ok = await setPriceItemActive(q, itemId, active);
    if (!ok) return { error: "That item no longer exists." };

    revalidateApp();
    return { ok: active ? "Back on the list." : "Withdrawn — it stays on past quotes." };
  });
}

/** For tidying a typo. Withdrawing is what you want for a service you stopped selling. */
export async function deletePriceItemAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const itemId = validId(formData.get("id"));
    if (!itemId) return { error: "That item could not be identified." };

    const ok = await deletePriceItem(q, itemId);
    if (!ok) return { error: "That item no longer exists." };

    /* A price disappearing is the sort of thing somebody asks about later —
       "why is the crane not on the list any more" — and the log is the only
       place that can answer. The item's own name is not recorded: the id is
       enough to find it, and the log must never carry record contents. */
    logWrite("delete", "price_item", { id: itemId, actor: q.ctx.userId });
    revalidateApp();
    return { ok: "Removed from the price list." };
  });
}
