"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2, Truck } from "lucide-react";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { Banner } from "@/components/ui/Banner";
import { useKeptForm } from "@/lib/use-kept-form";
import { useFormDisclosure } from "@/lib/form-disclosure";
import { useCanHandleMoney } from "@/components/shell/Abilities";
import { deleteSupplierAction, saveSupplierAction, type FormState } from "@/app/(app)/pricing/actions";
import type { Supplier } from "@/server/repos/suppliers";

/**
 * Who this business buys from.
 *
 * Kept here beside the prices rather than in Settings, because a supplier only
 * exists in this product as the source of a rate — there is nothing to
 * configure about one, and a screen you have to leave the price list to reach
 * is a screen nobody updates.
 *
 * The date is the point of the row as much as the name is. A list loaded in
 * March has to SAY March: a price that looks current and is not is worse than
 * one that admits its age, because nobody checks the first one.
 */
export function SuppliersCard({ suppliers }: { suppliers: Supplier[] }) {
  const canWrite = useCanHandleMoney();
  const save = useKeptForm<FormState>(saveSupplierAction, undefined);
  const remove = useKeptForm<FormState>(deleteSupplierAction, undefined);
  const [open, openForm, closeForm] = useFormDisclosure(save.state, (s) => Boolean(s?.ok));
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const startNew = () => {
    setEditing(null);
    openForm();
  };
  const startEdit = (s: Supplier) => {
    setEditing(s);
    openForm();
  };

  return (
    <Card className="mb-4">
      <CardHeader
        title="Suppliers"
        icon={<Truck className="h-[18px] w-[18px] text-accent" />}
        action={
          canWrite && !open ? (
            <button
              type="button"
              onClick={startNew}
              className="btn-accent focus-ring flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          ) : suppliers.length > 0 ? (
            <CardMeta value={suppliers.length}>
              {suppliers.length === 1 ? "supplier" : "suppliers"}
            </CardMeta>
          ) : undefined
        }
      />

      {save.state && !open && <Banner state={save.state} />}
      {remove.state && <Banner state={remove.state} />}

      {open && (
        <form
          onSubmit={save.onSubmit}
          /* Remounted per supplier, so switching which one is being edited
             replaces the values rather than keeping the last one's. */
          key={editing?.id ?? "new"}
          className="mb-4 space-y-3 border-b border-[var(--border)] pb-4"
        >
          {save.state?.error && <Banner state={save.state} />}
          {editing && <input type="hidden" name="id" value={editing.id} />}

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Name</span>
            <input
              name="name"
              required
              maxLength={120}
              autoFocus
              defaultValue={editing?.name ?? ""}
              placeholder="Stone Yard"
              className="field-input"
            />
          </label>

          <div className="grid grid-cols-1 gap-3 @min-[440px]:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">
                Email their list comes from
              </span>
              <input
                name="email"
                type="email"
                maxLength={320}
                defaultValue={editing?.email ?? ""}
                placeholder="sales@stoneyard.co.za"
                className="field-input"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Phone</span>
              <input
                name="phone"
                maxLength={40}
                defaultValue={editing?.phone ?? ""}
                placeholder="021 555 0142"
                className="field-input"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Notes</span>
            <textarea
              name="notes"
              rows={2}
              maxLength={2000}
              defaultValue={editing?.notes ?? ""}
              placeholder="Delivery on Tuesdays. Account 4412."
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
              {save.pending ? "Saving…" : editing ? "Save" : "Add supplier"}
            </button>
          </div>
        </form>
      )}

      {suppliers.length === 0 ? (
        <p className="text-sm text-faint">
          Nobody yet. Add the merchants you buy from, then paste their price lists in — a quote built
          on their current rates is the whole point of keeping them here.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {suppliers.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3.5 py-2.5"
              style={{ background: "var(--surface-2)" }}
            >
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-sm font-medium">{s.name}</span>
                <span className="block truncate text-xs text-faint">
                  {[
                    s.itemCount > 0
                      ? `${s.itemCount} ${s.itemCount === 1 ? "price" : "prices"}`
                      : "no prices loaded",
                    /* Said plainly. A list nobody has refreshed is the thing
                       this card exists to make visible. */
                    s.listUpdatedOn ? `list loaded ${s.listUpdatedOn}` : "never loaded",
                    s.email,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>

              {canWrite &&
                (confirming === s.id ? (
                  <form onSubmit={remove.onSubmit} className="flex shrink-0 items-center gap-1.5">
                    <input type="hidden" name="id" value={s.id} />
                    <span className="text-xs text-muted">Remove? Their prices stay.</span>
                    <button
                      type="submit"
                      disabled={remove.pending}
                      className="focus-ring rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-60"
                      style={{ background: "var(--red-soft)", color: "var(--red)" }}
                    >
                      Remove
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
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(s)}
                      aria-label={`Edit ${s.name}`}
                      className="btn-soft focus-ring rounded-lg p-2 text-muted transition-colors hover:text-accent"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(s.id)}
                      aria-label={`Remove ${s.name}`}
                      className="btn-soft focus-ring rounded-lg p-2 text-muted transition-colors hover:text-red"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </span>
                ))}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
