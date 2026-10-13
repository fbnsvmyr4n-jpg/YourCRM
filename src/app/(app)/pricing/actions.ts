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
import { decimal, id as validId, multiline, pick, text } from "@/server/validate";
import {
  applyPriceList,
  createSupplier,
  deleteSupplier,
  recordLoad,
  supplierItems,
  updateSupplier,
} from "@/server/repos/suppliers";
import { businessToday } from "@/server/repos/settings";
import { recordMovement, stockOnHand } from "@/server/repos/stock";
import { receiveGoods } from "@/server/repos/goods-received";
import { ADJUSTABLE_REASONS, REASON_DIRECTION, formatQty, type StockReason } from "@/data/stock";
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
      trackStock: formData.get("trackStock") === "on",
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

    const email = text(formData.get("email"), 320) || null;
    const autoLoad = formData.get("autoLoad") === "on";

    /*
       The switch cannot be on without an address to match on.

       `findSupplierList` matches on the ADDRESS and nothing else — a display
       name that happens to say "Stone Yard" is not a fact about who sent a
       message. So auto-loading a supplier with no address on file is a setting
       that can never once fire, and a control that silently does nothing is
       worse than one that is not offered: somebody turns it on, believes their
       prices are keeping themselves up to date, and quotes from a list that has
       not moved in a year.
    */
    if (autoLoad && !email) {
      return { error: "Add the email address their list comes from first — that is what a message is matched against." };
    }

    const input = {
      name,
      email,
      phone: text(formData.get("phone"), 40) || null,
      notes: multiline(formData.get("notes"), 2000) || null,
      autoLoad,
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

    /*
       Recorded here too, not only on the automatic path.

       A log that covered the unattended loads alone would answer "did the
       machine do this" and leave "who did" unanswerable — and when a figure
       looks wrong, the second is the question actually being asked. The message
       id travels when the list came from one, which is what stops that message
       going on offering to load a list it has already loaded.
    */
    await recordLoad(q, {
      supplierId,
      messageId: validId(formData.get("fromMessage")) || null,
      userId: q.ctx.userId,
      result: out,
    });

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


/* ------------------------------------------------------------------ */
/* Stock                                                               */
/* ------------------------------------------------------------------ */

/**
 * Move stock by hand: goods arrived, something was damaged, a count was taken.
 *
 * `sold` is deliberately not offerable. Stock leaves on an invoice, with the
 * line that took it recorded against the movement — a hand-entered sale would
 * be a number with no document behind it, and "which sale moved this?" is the
 * first question anybody asks of a stock figure.
 *
 * A STOCK TAKE is the odd one: the person types what is actually on the shelf,
 * and the movement recorded is the DIFFERENCE. Asking them to work that out
 * themselves is asking them to do arithmetic the screen already has both halves
 * of — and the half they would get wrong is the one that matters.
 */
export async function adjustStockAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withMoney(async (q) => {
    const priceItemId = validId(formData.get("priceItemId"));
    if (!priceItemId) return { error: "That item could not be identified." };

    const reason = pick(formData.get("reason"), ADJUSTABLE_REASONS) as StockReason | null;
    if (!reason) return { error: "Say why the stock moved." };

    const typed = decimal(formData.get("quantity"), 1_000_000, 3);
    if (typed === null) return { error: "That quantity could not be read as a number." };
    if (typed < 0) return { error: "Use the reason to say which way it moved, not a minus sign." };

    const item = await q.one<{ name: string; track_stock: boolean }>(
      `SELECT name, track_stock FROM price_items
        WHERE id = $2 AND sub_account_id = $1 AND deleted_at IS NULL`,
      [q.ctx.subAccountId, priceItemId]
    );
    if (!item) return { error: "That item no longer exists." };
    /* Said rather than silently written. An item nobody is counting has no
       shelf to move things on and off. */
    if (!item.track_stock) {
      return { error: `${item.name} is not stock you hold. Tick "I hold this as stock" on the item first.` };
    }

    const onHand = (await stockOnHand(q))[priceItemId] ?? 0;
    /* A stock take is the count itself; everything else is an amount. */
    const qtyChange =
      reason === "counted"
        ? Number((typed - onHand).toFixed(3))
        : REASON_DIRECTION[reason] === "out"
          ? -typed
          : typed;

    if (qtyChange === 0) {
      return reason === "counted"
        ? { ok: `${item.name} counted — the shelf already said ${formatQty(onHand)}.` }
        : { error: "Nothing to move." };
    }

    await recordMovement(q, {
      priceItemId,
      qtyChange,
      reason,
      note: multiline(formData.get("note"), 500) || null,
      userId: q.ctx.userId,
    });

    logWrite("update", "stock", { id: priceItemId, actor: q.ctx.userId });
    revalidateApp();

    const now = onHand + qtyChange;
    return {
      ok: `${item.name}: ${qtyChange > 0 ? "+" : ""}${formatQty(qtyChange)}, now ${formatQty(now)}.`,
    };
  });
}


/**
 * Record a delivery: goods arriving from a supplier, onto the shelf.
 *
 * The counterpart to a sale and the half that makes the stock figure
 * trustworthy rather than a number that only ever falls. Saving the slip IS
 * the movement — a delivery somebody typed and did not post is a delivery that
 * will not be posted, and the shelf would be short with the explanation one
 * screen away.
 */
export async function receiveGoodsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withMoney(async (q) => {
    const supplierId = validId(formData.get("supplierId"));
    if (!supplierId) return { error: "Say who delivered it." };

    const receivedOn = text(formData.get("receivedOn"), 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) return { error: "Give the day it arrived." };

    /* Read in pairs, the way the rows are drawn. A line with an item and no
       quantity is somebody mid-typing, not an error — it is dropped. A
       quantity with no item is the opposite and is also dropped, because
       there is no shelf to put it on. */
    const itemIds = formData.getAll("receivedItemId").map((v) => validId(v));
    const quantities = formData.getAll("receivedQuantity");
    const lines: { priceItemId: string; quantity: number }[] = [];
    for (let i = 0; i < itemIds.length; i++) {
      const priceItemId = itemIds[i];
      if (!priceItemId) continue;
      const quantity = decimal(quantities[i], 1_000_000, 3);
      if (quantity === null) return { error: "A quantity could not be read as a number." };
      if (quantity <= 0) continue;
      lines.push({ priceItemId, quantity });
    }

    const result = await receiveGoods(q, {
      supplierId,
      reference: text(formData.get("reference"), 80) || null,
      receivedOn,
      note: multiline(formData.get("note"), 2000) || null,
      lines,
      userId: q.ctx.userId,
    });
    if ("error" in result) return { error: result.error };

    logWrite("create", "goods_received", { id: result.id, actor: q.ctx.userId });
    revalidateApp();
    return {
      ok: `Delivery recorded — ${result.moved} ${result.moved === 1 ? "item" : "items"} on the shelf.`,
    };
  });
}
