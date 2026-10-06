"use client";

import { useMemo, useState } from "react";
import { SuppliersCard } from "@/components/pricing/SuppliersCard";
import { SupplierImport } from "@/components/pricing/SupplierImport";
import type { Supplier } from "@/server/repos/suppliers";
import { useCanHandleMoney } from "@/components/shell/Abilities";
import { useKeptForm } from "@/lib/use-kept-form";
import { EyeOff, Pencil, Plus, RotateCcw, Search, Tags, Trash2 } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Card, CardHeader, CardMeta } from "@/components/ui/Card";
import { clsx } from "@/lib/clsx";
import { useFormDisclosure } from "@/lib/form-disclosure";
import { useMoney } from "@/components/money/CurrencyProvider";
import type { PriceItem } from "@/server/repos/pricing";
import {
  deletePriceItemAction,
  savePriceItemAction,
  togglePriceItemAction,
  type FormState,
} from "./actions";

/**
 * What this business charges.
 *
 * Built before the agent that will read it, and that order is deliberate: an AI
 * asked to quote a crane with no price list produces a number that looks like a
 * price and is not one. With a list, drafting a quotation is selection rather
 * than invention, and every figure on it traces back to a row somebody here
 * typed.
 *
 * It earns its place without the agent too — this is the list a person picks
 * from when writing a quote by hand.
 */

export function PricingView({
  items,
  suppliers = [],
  prefill = null,
}: {
  items: PriceItem[];
  suppliers?: Supplier[];
  /** A list carried here from a supplier's message — see `supplier-mail.ts`. */
  prefill?: { supplierId: string; text: string; messageId?: string | null } | null;
}) {
  const canWrite = useCanHandleMoney();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<PriceItem | null>(null);

  const { state: saveState, onSubmit: save, pending: saving } = useKeptForm<FormState>(savePriceItemAction,
    undefined);
  const { state: toggleState, onSubmit: toggle, pending: toggling } = useKeptForm<FormState>(togglePriceItemAction,
    undefined);
  const { state: removeState, onSubmit: remove, pending: removing } = useKeptForm<FormState>(deletePriceItemAction,
    undefined);
  const [adding, openAdd, closeAdd] = useFormDisclosure(saveState, (s) => Boolean(s?.ok));

  const shown = useMemo(() => {
    const t = query.trim().toLowerCase();
    if (!t) return items;
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(t) ||
        (i.description ?? "").toLowerCase().includes(t) ||
        i.unit.toLowerCase().includes(t)
    );
  }, [items, query]);

  const live = shown.filter((i) => i.active);
  const withdrawn = shown.filter((i) => !i.active);

  /* The edit form and the add form are the same form. Two would be two places
     to fix a validation message. */
  const formOpen = adding || editing !== null;

  return (
    <div className="mx-auto max-w-[1080px] animate-fade-up">
      <div className="flex flex-wrap items-end justify-between gap-3 pb-4 pt-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Price list</h1>
          <p className="mt-1 text-sm text-muted">What you charge, and what a quote is built from.</p>
        </div>
        {/* The price list is reference data a viewer reads — it is what a
            quotation is built from, so knowing the rates is part of looking at
            the work. Keeping and changing them is not. */}
        {canWrite && !formOpen && (
          <button
            type="button"
            onClick={openAdd}
            className="btn-accent focus-ring flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"
          >
            <Plus className="h-4 w-4" />
            Add an item
          </button>
        )}
      </div>

      {/* Who the prices come from, and the way to load a whole list from one.
          Above the list itself, because loading a supplier's sheet is how most
          of these rows get here — typing one by hand is the exception. */}
      <SuppliersCard suppliers={suppliers} />
      <SupplierImport suppliers={suppliers} prefill={prefill} />

      {formOpen && (
        <Card className="mb-4">
          <CardHeader
            title={editing ? `Edit ${editing.name}` : "New price"}
            icon={<Tags className="h-[18px] w-[18px] text-accent" />}
          />
          <form
            onSubmit={save}
            /* Remounted per item, so switching which one you are editing
               replaces the values rather than keeping the last one's. */
            key={editing?.id ?? "new"}
            className="space-y-3"
          >
            <Banner state={saveState} />
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <div className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-[1fr_140px_140px]">
              <Field label="Item" name="name" defaultValue={editing?.name ?? ""} placeholder="Mobile crane hire" required />
              <Field label="Unit" name="unit" defaultValue={editing?.unit ?? ""} placeholder="per day" />
              <Field
                label="Price"
                name="unitPrice"
                type="number"
                step="0.01"
                min="0"
                defaultValue={editing ? String(editing.unitCents / 100) : ""}
                placeholder="12000"
                required
              />
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Description</span>
              <textarea
                name="description"
                rows={2}
                defaultValue={editing?.description ?? ""}
                placeholder="What is included, so a quote line reads properly"
                className="field-input resize-y"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  closeAdd();
                }}
                className="btn-soft focus-ring rounded-xl px-4 py-2.5 text-sm font-medium text-muted"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Card>
      )}

      <label className="relative mb-4 block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the price list"
          aria-label="Search the price list"
          /* Padding in the style attribute: `field-input` sets the `padding`
             shorthand in a single-class rule, which beats `pl-9` by source
             order. The Notes search had the placeholder under the magnifier
             for exactly this reason. */
          className="field-input"
          style={{ paddingLeft: 36 }}
        />
      </label>

      <div className="flex flex-col gap-2 empty:hidden">
        <Banner state={toggleState} />
        <Banner state={removeState} />
        {!formOpen && <Banner state={saveState} />}
      </div>

      {items.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            Nothing priced yet. Add what you sell — &ldquo;Mobile crane hire, per day, $12,000&rdquo;
            — and quotes can be built from it instead of typed from memory.
          </p>
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">Nothing matches that.</p>
        </Card>
      ) : (
        <div className="mt-2 flex flex-col gap-4">
          <Group
            title="On the list"
            items={live}
            onEdit={setEditing}
            onToggle={toggle}
            onRemove={remove}
            busy={toggling || removing}
          />
          {/* Withdrawn items are shown, not hidden. This is the screen where
              somebody brings one back, and a list that silently omitted them
              would make that impossible. */}
          <Group
            title="Withdrawn"
            items={withdrawn}
            onEdit={setEditing}
            onToggle={toggle}
            onRemove={remove}
            busy={toggling || removing}
          />
        </div>
      )}
    </div>
  );
}

function Group({
  title,
  items,
  onEdit,
  onToggle,
  onRemove,
  busy,
}: {
  title: string;
  items: PriceItem[];
  onEdit: (item: PriceItem) => void;
  onToggle: React.FormEventHandler<HTMLFormElement>;
  onRemove: React.FormEventHandler<HTMLFormElement>;
  busy: boolean;
}) {
  const canWrite = useCanHandleMoney();
  /* Cents when there are any — a rate of 12.50 an hour is ordinary. */
  const { format } = useMoney();
  const money = (cents: number) => format(cents, "exact");
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title={title}
        icon={<Tags className="h-[18px] w-[18px] text-accent" />}
        action={<CardMeta value={items.length}>{items.length === 1 ? "item" : "items"}</CardMeta>}
      />
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            className={clsx("flex flex-wrap items-center gap-3 rounded-xl px-3.5 py-3")}
            style={{ background: "var(--surface-2)", opacity: item.active ? 1 : 0.65 }}
          >
            <div className="min-w-0 flex-1 leading-tight">
              <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <span className="truncate">{item.name}</span>
                {/* Whose price this is.

                    Two merchants can both sell paving stone at different
                    rates — that is the point of keeping suppliers — so two
                    rows with the same name and nothing to tell them apart
                    would be a worse list than the single one this replaced.
                    Nothing is shown for a price typed by hand, because
                    inventing a source for it would be the other failure. */}
                {item.supplierName && (
                  <span
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                  >
                    {item.supplierName}
                  </span>
                )}
              </p>
              <p className="mt-0.5 truncate text-xs text-faint">
                {item.description ?? `Charged ${item.unit}`}
              </p>
            </div>

            {/* Price and controls take their own line on a phone: the row is
                `flex-wrap`, so a full-width group cannot share the line and the
                item name keeps the whole of the first one. */}
            <div className="flex w-full items-center justify-end gap-2 @min-[440px]:w-auto">
              <span className="shrink-0 text-right leading-tight">
                <span className="block text-sm font-semibold tabular-nums">
                  {money(item.unitCents)}
                </span>
                <span className="block text-[11px] text-faint">{item.unit}</span>
              </span>

              {canWrite && (
              <>
              <button
                type="button"
                onClick={() => onEdit(item)}
                aria-label={`Edit ${item.name}`}
                className="btn-soft focus-ring shrink-0 rounded-lg p-2 text-muted transition-colors hover:text-accent"
              >
                <Pencil className="h-4 w-4" />
              </button>

              <form onSubmit={onToggle} className="shrink-0">
                <input type="hidden" name="id" value={item.id} />
                <input type="hidden" name="active" value={item.active ? "false" : "true"} />
                <button
                  type="submit"
                  disabled={busy}
                  aria-label={item.active ? `Withdraw ${item.name}` : `Bring back ${item.name}`}
                  className="btn-soft focus-ring rounded-lg p-2 text-muted transition-colors hover:text-amber disabled:opacity-60"
                >
                  {item.active ? <EyeOff className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                </button>
              </form>

              <form onSubmit={onRemove} className="shrink-0">
                <input type="hidden" name="id" value={item.id} />
                <button
                  type="submit"
                  disabled={busy}
                  aria-label={`Delete ${item.name}`}
                  className="btn-soft focus-ring rounded-lg p-2 text-muted transition-colors hover:text-red disabled:opacity-60"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </form>
              </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Field({
  label,
  name,
  type = "text",
  defaultValue,
  placeholder,
  required,
  step,
  min,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  step?: string;
  min?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      <input
        name={name}
        type={type}
        step={step}
        min={min}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        className="field-input"
      />
    </label>
  );
}
