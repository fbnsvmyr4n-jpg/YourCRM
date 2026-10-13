"use client";

import { useMemo, useState } from "react";
import { PackagePlus, Truck } from "lucide-react";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { useKeptForm } from "@/lib/use-kept-form";
import { useFormDisclosure } from "@/lib/form-disclosure";
import { useCanHandleMoney } from "@/components/shell/Abilities";
import { formatQty } from "@/data/stock";
import { receiveGoodsAction, type FormState } from "@/app/(app)/pricing/actions";
import type { Supplier } from "@/server/repos/suppliers";
import type { GoodsReceived } from "@/data/goods-received";

/** Enough rows for a normal delivery; blanks are dropped on save. */
const ROWS = [0, 1, 2, 3, 4];

/**
 * A delivery arriving, and the shelf going up.
 *
 * The counterpart to a sale. Without it stock only ever falls, and a figure
 * that can only fall is one everybody learns to ignore within a month.
 *
 * ── Why there is no "post" step ───────────────────────────────────────────
 *
 * Saving the slip moves the goods. A delivery somebody typed and did not post
 * is a delivery that will not be posted — the shelf short, and the explanation
 * sitting one screen away in a draft nobody opens again.
 */
export function ReceiveGoods({
  suppliers,
  items,
  received,
  today,
}: {
  suppliers: Supplier[];
  /** Only what this workspace holds as stock — see `track_stock`. */
  items: { id: string; name: string; unit: string; supplierName: string | null }[];
  received: GoodsReceived[];
  /** The business's own day, so a delivery logged at 01:00 is not yesterday's. */
  today: string;
}) {
  const canWrite = useCanHandleMoney();
  const save = useKeptForm<FormState>(receiveGoodsAction, undefined);
  const [open, openForm, closeForm] = useFormDisclosure(save.state, (s) => Boolean(s?.ok));

  /*
     Held, never read straight from the list. `suppliers[0]` is evaluated once,
     and the first supplier a workspace adds arrives after this has mounted —
     the select then showed a name while posting an empty id, which is the bug
     the supplier import had.
  */
  const [held, setHeld] = useState("");
  const supplierId = suppliers.some((s) => s.id === held) ? held : (suppliers[0]?.id ?? "");

  /* Two prices can share a name, so the picker says whose where it has to.
     Same rule as the quote line picker — see `labelFor` there. */
  const ambiguous = useMemo(() => {
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const i of items) {
      const key = i.name.trim().toLowerCase();
      if (seen.has(key)) twice.add(key);
      seen.add(key);
    }
    return twice;
  }, [items]);
  const label = (i: { name: string; supplierName: string | null }) =>
    ambiguous.has(i.name.trim().toLowerCase())
      ? `${i.name} · ${i.supplierName ?? "no supplier"}`
      : i.name;

  if (!canWrite) return null;

  /* Nothing to receive onto. Said plainly rather than offering a form whose
     every line would be refused — the fix is one tick on an item. */
  if (items.length === 0) {
    return null;
  }

  return (
    <Card className="mb-4">
      <CardHeader
        title="Deliveries"
        icon={<Truck className="h-[18px] w-[18px] text-accent" />}
        action={
          !open ? (
            <button
              type="button"
              onClick={openForm}
              className="btn-accent focus-ring flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold"
            >
              <PackagePlus className="h-3.5 w-3.5" />
              Record one
            </button>
          ) : received.length > 0 ? (
            <CardMeta value={received.length}>
              {received.length === 1 ? "delivery" : "deliveries"}
            </CardMeta>
          ) : undefined
        }
      />

      {save.state && !open && <Banner state={save.state} />}

      {open && (
        <form onSubmit={save.onSubmit} className="mb-4 space-y-3 border-b border-[var(--border)] pb-4">
          {save.state?.error && <Banner state={save.state} />}

          <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Who delivered it</span>
              <select
                name="supplierId"
                value={supplierId}
                onChange={(e) => setHeld(e.target.value)}
                className="field-input"
              >
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              {/* Theirs, not ours: it is what the supplier's invoice will cite
                  when the two have to be matched. Optional, because plenty of
                  deliveries come with a scribble and refusing to record one
                  for want of a number is how stock stops being recorded. */}
              <span className="mb-1.5 block text-xs font-medium text-muted">
                Their delivery note
              </span>
              <input name="reference" maxLength={80} placeholder="DN-4471" className="field-input" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Arrived</span>
              <input name="receivedOn" type="date" defaultValue={today} className="field-input" />
            </label>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">What arrived</p>
            <div className="flex flex-col gap-2">
              {ROWS.map((i) => (
                <div key={i} className="grid grid-cols-[1fr_110px] gap-2">
                  <select name="receivedItemId" defaultValue="" className="field-input" aria-label={`Line ${i + 1} item`}>
                    <option value="">—</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {label(item)}
                      </option>
                    ))}
                  </select>
                  <input
                    name="receivedQuantity"
                    type="number"
                    step="0.001"
                    min="0"
                    placeholder="Qty"
                    className="field-input"
                    aria-label={`Line ${i + 1} quantity`}
                  />
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-faint">
              Only things you hold as stock can be received. Leave a row blank to skip it.
            </p>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Note</span>
            <textarea
              name="note"
              rows={2}
              maxLength={2000}
              placeholder="Two bags split on arrival."
              className="field-input resize-y"
            />
          </label>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={closeForm}
              className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={save.pending}
              className="btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60"
            >
              {save.pending ? "Recording…" : "Record delivery"}
            </button>
          </div>
        </form>
      )}

      {received.length === 0 ? (
        <p className="text-sm text-faint">
          Nothing received yet. Recording a delivery puts the goods on the shelf — without it, stock
          only ever goes down.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {received.map((slip) => (
            <li
              key={slip.id}
              className="rounded-xl px-3.5 py-2.5"
              style={{ background: "var(--surface-2)" }}
            >
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium">{slip.supplierName}</span>
                <span className="text-xs text-faint">
                  {slip.receivedOn}
                  {slip.reference && ` · ${slip.reference}`}
                  {slip.receivedByName && ` · ${slip.receivedByName}`}
                </span>
              </p>
              <p className="mt-0.5 truncate text-xs text-faint">
                {slip.lines
                  .map((l) => `${formatQty(l.quantity)} ${l.unit} ${l.itemName}`)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
