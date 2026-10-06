"use server";

import {
  deletePriceItem,
  savePriceItem,
  setPriceItemActive,
} from "@/server/repos/pricing";
import { logWrite } from "@/server/log";
import { revalidateApp } from "@/server/revalidate";
import { withCurrentTenant } from "@/server/tenant-session";
import type { TenantQuery } from "@/server/tenant";
import { decimal, id as validId, multiline, text } from "@/server/validate";
import {
  applyPriceList,
  createSupplier,
  deleteSupplier,
  supplierItems,
  updateSupplier,
} from "@/server/repos/suppliers";
import { businessToday } from "@/server/repos/settings";
import {
  describeChanges,
  parsePriceList,
  planChanges,
  type PriceChange,
  type UnreadLine,
} from "@/server/price-import";

/**
 * Maintaining the price list, and the suppliers behind it.
 *
 * MONEY by the gate's definition, not customer data — there is not one
 * customer fact here. It was the customer door, which kept the finance role
 * out of the list they need most: reconciling a supplier's invoice against the
 * rate that supplier agreed is the job, and without this they are checking an
 * invoice against nothing. IT is still refused, because what the business
 * charges is no part of fixing the machine.
 */

/** Every action in this file, through the MONEY door. Named once — see the inbox. */
const withMoney = <T>(fn: (q: TenantQuery) => Promise<T>) => withCurrentTenant(fn, { money: true });

export type FormState = { ok?: string; error?: string } | undefined;

/** A price ceiling per unit, in whole currency units. */
const MAX_UNIT_PRICE = 100_000_000;

export async function savePriceItemAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  return withMoney(async (q) => {
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
  return withMoney(async (q) => {
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
  return withMoney(async (q) => {
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

/* ------------------------------------------------------------------ */
/* Suppliers, and loading what they charge                             */
/*                                                                     */
/* The price list is really a set of suppliers' lists. Nobody retypes   */
/* forty rows, so a list arrives pasted or dropped in and is read.      */
/* ------------------------------------------------------------------ */

export async function saveSupplierAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withMoney(async (q) => {
    const name = text(formData.get("name"), 120);
    if (!name.trim()) return { error: "Give the supplier a name." };

    const input = {
      name,
      email: text(formData.get("email"), 320) || null,
      phone: text(formData.get("phone"), 40) || null,
      notes: multiline(formData.get("notes"), 2000) || null,
    };

    const existingId = validId(formData.get("id"));
    if (existingId) {
      if (!(await updateSupplier(q, existingId, input))) {
        return { error: "That supplier no longer exists." };
      }
      logWrite("update", "supplier", { id: existingId, actor: q.ctx.userId });
      revalidateApp();
      return { ok: `${name} saved.` };
    }

    const made = await createSupplier(q, input);
    if (!made) return { error: "That supplier could not be saved." };
    logWrite("create", "supplier", { id: made.id, actor: q.ctx.userId });
    revalidateApp();
    return { ok: `${made.name} added.` };
  });
}

export async function deleteSupplierAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withMoney(async (q) => {
    const id = validId(formData.get("id"));
    if (!id) return { error: "That supplier could not be identified." };
    if (!(await deleteSupplier(q, id))) return { error: "That supplier no longer exists." };
    logWrite("delete", "supplier", { id, actor: q.ctx.userId });
    revalidateApp();
    /* Said out loud, because it is the question somebody asks straight after
       pressing it. */
    return { ok: "Supplier removed. Their prices are still on the list." };
  });
}

export type ImportPreview = {
  supplierId: string;
  changes: PriceChange[];
  unread: UnreadLine[];
  summary: string;
};

/**
 * Read a pasted list and say what it WOULD do. Writes nothing.
 *
 * Separated from applying it on purpose. A price list is what every quotation
 * is built from, so pasting the wrong column — or last year's file — silently
 * re-prices the whole business. "47 new, 12 with a new price, 3 we could not
 * read" is a sentence somebody can check in five seconds, and this is what
 * produces it.
 */
export async function previewPriceListAction(
  _prev: ImportPreview | FormState,
  formData: FormData
): Promise<ImportPreview | FormState> {
  return withMoney(async (q) => {
    const supplierId = validId(formData.get("supplierId"));
    if (!supplierId) return { error: "Choose which supplier this list is from." };

    const pasted = multiline(formData.get("pasted"), 200_000);
    if (!pasted.trim()) return { error: "Paste or drop the list in first." };

    const { lines, unread } = parsePriceList(pasted);
    if (lines.length === 0 && unread.length === 0) {
      return { error: "There was nothing in that." };
    }

    const changes = planChanges(lines, await supplierItems(q, supplierId));
    return { supplierId, changes, unread, summary: describeChanges(changes, unread.length) };
  });
}

/**
 * Apply a list that has been read and looked at.
 *
 * Re-reads the pasted text server-side rather than trusting a plan posted back
 * from the browser: the preview is for a person to look at, not a payload to
 * act on. A changed price arriving in a hidden field is a price nobody typed
 * and nobody approved.
 */
export async function applyPriceListAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withMoney(async (q) => {
    const supplierId = validId(formData.get("supplierId"));
    if (!supplierId) return { error: "Choose which supplier this list is from." };

    const pasted = multiline(formData.get("pasted"), 200_000);
    if (!pasted.trim()) return { error: "Paste or drop the list in first." };

    const { lines, unread } = parsePriceList(pasted);
    const changes = planChanges(lines, await supplierItems(q, supplierId));
    const out = await applyPriceList(q, supplierId, changes, await businessToday(q));

    logWrite("update", "price_list", { id: supplierId, actor: q.ctx.userId });
    revalidateApp();

    const said = [
      out.added && `${out.added} added`,
      out.repriced && `${out.repriced} repriced`,
      out.unchanged && `${out.unchanged} unchanged`,
      /* Named again at the end, not only in the preview: the count that
         matters most is the one somebody is about to stop thinking about. */
      unread.length && `${unread.length} still unread`,
    ].filter(Boolean);
    return { ok: said.length ? `Loaded — ${said.join(", ")}.` : "Nothing in that list to apply." };
  });
}
