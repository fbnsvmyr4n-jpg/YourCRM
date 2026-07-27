"use client";

import { useMemo, useState } from "react";
import { GripVertical, Plus, Trash2, TrendingUp, Wallet, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { STAGES, type Deal, type StageId } from "@/data/deals";
import { clsx } from "@/lib/clsx";
import { addDealAction, deleteDealAction, moveDealAction } from "./actions";

const WEIGHTS: Record<StageId, number> = {
  lead: 0.1,
  qualified: 0.3,
  proposal: 0.5,
  negotiation: 0.7,
  won: 1,
};

function money(n: number) {
  if (n >= 1000) {
    const k = n / 1000;
    return `$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return `$${n}`;
}
function fullMoney(n: number) {
  return `$${n.toLocaleString()}`;
}

export function DealsBoard({ deals }: { deals: Deal[] }) {
  const [items, setItems] = useState<Deal[]>(deals);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<StageId | null>(null);
  const [addOpen, setAddOpen] = useState<StageId | true | null>(null);
  const [busy, setBusy] = useState(false);

  const summary = useMemo(() => {
    const open = items.filter((d) => d.stage !== "won");
    const openValue = open.reduce((s, d) => s + d.value, 0);
    // `?? 0` is deliberate: an unrecognised stage has no weight, and without
    // this the whole forecast renders as "$NaN" rather than just excluding it.
    const weighted = items.reduce((s, d) => s + d.value * (WEIGHTS[d.stage] ?? 0), 0);
    const won = items.filter((d) => d.stage === "won").reduce((s, d) => s + d.value, 0);
    return { openValue, weighted, won, count: items.length };
  }, [items]);

  function handleDrop(stage: StageId) {
    setOverStage(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const current = items.find((d) => d.id === id);
    if (!current || current.stage === stage) return;
    setItems((prev) => prev.map((d) => (d.id === id ? { ...d, stage } : d)));
    moveDealAction(id, stage);
  }

  async function handleAdd(formData: FormData) {
    setBusy(true);
    try {
      const created = await addDealAction(formData);
      if (created) setItems((prev) => [created, ...prev]);
      setAddOpen(null);
    } finally {
      setBusy(false);
    }
  }

  function handleDelete(id: string) {
    setItems((prev) => prev.filter((d) => d.id !== id));
    deleteDealAction(id);
  }

  const defaultStage = addOpen && addOpen !== true ? addOpen : "lead";

  return (
    <div className="mx-auto flex h-[calc(100vh-104px)] max-w-[1600px] animate-fade-up flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4 pt-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Deals Pipeline</h1>
          <p className="mt-1 text-sm text-muted">Drag deals across stages to move them through your pipeline.</p>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"
        >
          <Plus className="h-[16px] w-[16px]" /> Add Deal
        </button>
      </div>

      {/* Summary */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryTile icon={<Wallet className="h-5 w-5" />} label="Open Pipeline" value={fullMoney(summary.openValue)} tone="var(--accent)" soft="var(--accent-soft)" />
        <SummaryTile icon={<TrendingUp className="h-5 w-5" />} label="Weighted Forecast" value={fullMoney(Math.round(summary.weighted))} tone="var(--purple)" soft="var(--purple-soft)" />
        <SummaryTile icon={<Wallet className="h-5 w-5" />} label="Closed Won" value={fullMoney(summary.won)} tone="var(--green)" soft="var(--green-soft)" />
        <SummaryTile icon={<GripVertical className="h-5 w-5" />} label="Total Deals" value={String(summary.count)} tone="var(--amber)" soft="var(--amber-soft)" />
      </div>

      {/* Board */}
      <div className="-mx-1 flex flex-1 gap-4 overflow-x-auto px-1 pb-2">
        {STAGES.map((stage) => {
          const stageDeals = items.filter((d) => d.stage === stage.id);
          const total = stageDeals.reduce((s, d) => s + d.value, 0);
          const isOver = overStage === stage.id;
          return (
            <div
              key={stage.id}
              onDragOver={(e) => {
                e.preventDefault();
                if (overStage !== stage.id) setOverStage(stage.id);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage(null);
              }}
              onDrop={() => handleDrop(stage.id)}
              className={clsx(
                "flex w-[300px] shrink-0 flex-col rounded-2xl border transition-colors",
                isOver ? "border-[var(--border-strong)] bg-[var(--raise)]" : "border-[var(--border)]"
              )}
            >
              {/* Column header */}
              <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }} />
                  <span className="text-sm font-semibold">{stage.label}</span>
                  <span className="rounded-full px-1.5 py-0.5 text-[11px] font-semibold text-muted" style={{ background: "var(--raise)" }}>
                    {stageDeals.length}
                  </span>
                </div>
                <span className="text-xs font-semibold" style={{ color: stage.color }}>
                  {money(total)}
                </span>
              </div>

              {/* Cards */}
              <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto p-3">
                {stageDeals.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    dragging={dragId === deal.id}
                    onDragStart={() => setDragId(deal.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverStage(null);
                    }}
                    onDelete={() => handleDelete(deal.id)}
                  />
                ))}
                <button
                  onClick={() => setAddOpen(stage.id)}
                  className="focus-ring flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-[var(--border)] py-2 text-xs font-medium text-faint transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                >
                  <Plus className="h-3.5 w-3.5" /> Add deal
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {addOpen !== null && (
        <AddDealModal busy={busy} defaultStage={defaultStage} onClose={() => setAddOpen(null)} onSubmit={handleAdd} />
      )}
    </div>
  );
}

function SummaryTile({
  icon,
  label,
  value,
  tone,
  soft,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: string;
  soft: string;
}) {
  return (
    <div className="card flex items-center gap-3 p-4">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style={{ background: soft, color: tone }}>
        {icon}
      </span>
      <div className="min-w-0 leading-tight">
        <p className="truncate text-xl font-bold tabular-nums">{value}</p>
        <p className="text-[11px] text-faint">{label}</p>
      </div>
    </div>
  );
}

function DealCard({
  deal,
  dragging,
  onDragStart,
  onDragEnd,
  onDelete,
}: {
  deal: Deal;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", deal.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={clsx(
        "group cursor-grab rounded-xl border border-[var(--border)] bg-[var(--panel-solid)] p-3 transition-all active:cursor-grabbing hover:border-[var(--border-strong)]",
        dragging && "opacity-40"
      )}
      style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold leading-snug">{deal.title}</p>
        <button
          onClick={onDelete}
          className="shrink-0 text-faint opacity-0 transition-opacity hover:text-[var(--red)] group-hover:opacity-100"
          aria-label="Delete deal"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Avatar initials={deal.initials} color={deal.color} size="sm" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-xs font-medium">{deal.contact}</p>
          <p className="truncate text-[11px] text-faint">{deal.company}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-[var(--border)] pt-2.5">
        <span className="text-sm font-bold text-green">{money(deal.value)}</span>
        <span className="text-[11px] text-faint">{deal.closeDate}</span>
      </div>
    </div>
  );
}

/* ---------------- Add Deal modal ---------------- */

function AddDealModal({
  busy,
  defaultStage,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  defaultStage: StageId;
  onClose: () => void;
  onSubmit: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <form action={onSubmit} className="card relative z-10 w-full max-w-md p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Add Deal</h2>
          <button type="button" onClick={onClose} className="text-faint hover:text-[var(--text)]" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <Field name="title" label="Deal Title" required autoFocus placeholder="e.g. Website Redesign" />
          <div className="grid grid-cols-2 gap-4">
            <Field name="contact" label="Contact" placeholder="Full name" />
            <Field name="company" label="Company" placeholder="Company" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field name="value" label="Value ($)" type="number" placeholder="10000" />
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Stage</span>
              <select
                name="stage"
                defaultValue={defaultStage}
                className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel-solid)] px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-[var(--border-strong)]"
              >
                {STAGES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="btn-soft focus-ring rounded-xl px-5 py-2.5 text-sm font-medium">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60">
            {busy ? "Saving…" : "Add Deal"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  name,
  label,
  type = "text",
  required,
  autoFocus,
  placeholder,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">
        {label}
        {required && <span className="text-[var(--red)]"> *</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        min={type === "number" ? 0 : undefined}
        className="w-full rounded-xl border border-[var(--border)] bg-transparent px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-[var(--border-strong)]"
      />
    </label>
  );
}
