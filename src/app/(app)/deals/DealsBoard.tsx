"use client";

import { useMemo, useState } from "react";
import { Coins, GripVertical, HandCoins, Plus, Trash2, Wallet, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Overlay } from "@/components/ui/Overlay";
import { BOARD_STAGES as STAGES, carriesMoney } from "@/data/pipeline";
import type { DealRecord, Stage as StageId } from "@/server/repos/deals";
import type { AvatarColor } from "@/components/ui/Avatar";

/**
 * A deal, decorated with what the card shows and the record does not store.
 *
 * `contact`, `company`, `initials` and `color` were columns on the old deal —
 * a copy of the person's details sitting on the opportunity, which is how they
 * drifted apart from the contact record. The link is a foreign key now, so the
 * name is looked up rather than duplicated.
 *
 * Money stays in cents all the way to the formatter. Converting on the way in
 * and again on the way out is how a figure ends up 100× wrong.
 */
export type Deal = DealRecord & {
  contact: string;
  company: string;
  initials: string;
  color: AvatarColor;
  /** Whole-unit value for display only; the source of truth is `valueCents`. */
  value: number;
  splitTotal?: number;
  closeDate: string;
};

const AVATAR_COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

function paletteFor(id: string): AvatarColor {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function decorateDeal(
  d: DealRecord,
  contacts: { id: string; name: string; info: string | null }[]
): Deal {
  const person = contacts.find((c) => c.id === d.contactId);
  const name = person?.name ?? "";
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    ...d,
    contact: name,
    company: person?.info ?? "",
    initials: ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "—",
    color: paletteFor(d.id),
    value: d.valueCents / 100,
    splitTotal: d.splitTotalCents == null ? undefined : d.splitTotalCents / 100,
    // The close date the old model stored was an expectation nobody read.
    // What is shown now is the date the deal actually closed, or nothing.
    closeDate: d.wonAt ? new Date(d.wonAt).toLocaleDateString() : "",
  };
}
import { clsx } from "@/lib/clsx";
import {
  addDealAction,
  deleteDealAction,
  moveDealAction,
  recordPaymentAction,
  setDealValueAction,
} from "./actions";

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

/** A won record is only part of the story while it's short of the contract. */
const isPartiallyPaid = (d: Deal) =>
  isWon(d) && d.splitTotal !== undefined && d.value < d.splitTotal;

const PARTIAL = "#f97316"; // orange — money in, but not all of it

/**
 * Won-ness is a recorded fact, not a position on the board.
 *
 * `won_at` survives the deal moving on to Delivery and Referral, which are
 * post-close stages. Reading the stage instead would make revenue fall the
 * moment work began — success looking like a loss.
 */
const isWon = (d: Deal) => d.wonAt !== null;

export function DealsBoard({ deals }: { deals: Deal[] }) {
  const [items, setItems] = useState<Deal[]>(deals);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<StageId | null>(null);
  const [addOpen, setAddOpen] = useState<StageId | true | null>(null);
  const [active, setActive] = useState<Deal | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Header totals.
   *
   * Open Pipeline is the Proposals column alone — work quoted but not yet
   * committed. What used to sit here was every non-won deal added together,
   * including leads nobody had spoken to.
   *
   * Negotiations Owed replaces "Weighted Forecast", which multiplied each deal
   * by a made-up probability (a lead counted for 10% of a number that was
   * itself a guess) and presented the result as money. This is the real sum of
   * what has been invoiced and is still outstanding.
   */
  const summary = useMemo(() => {
    const sum = (stage: StageId) =>
      items.filter((d) => d.stage === stage).reduce((s, d) => s + d.value, 0);
    return {
      // Presented but not yet closed — the work that has had a number put on
      // it. "Proposals" and "Negotiations" were stages in a pipeline nobody
      // actually ran.
      proposals: sum("demo"),
      owed: sum("discovery"),
      // Won is read from the recorded fact, so it survives Delivery and
      // Referral rather than falling the moment delivery begins.
      won: items.filter(isWon).reduce((s, d) => s + d.value, 0),
      count: items.length,
    };
  }, [items]);

  function handleDrop(stage: StageId) {
    setOverStage(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;

    const current = items.find((d) => d.id === id);
    if (!current || current.stage === stage) return;

    // Settling the remainder merges it into the record holding the part already
    // paid. Mirrored here so the board doesn't briefly show two cards before
    // the server response lands.
    const sibling =
      stage === "won" && current.splitId
        ? items.find((d) => d.id !== id && d.splitId === current.splitId && isWon(d))
        : undefined;

    setItems((prev) =>
      sibling
        ? prev
            .filter((d) => d.id !== id)
            .map((d) => (d.id === sibling.id ? { ...d, value: d.value + current.value } : d))
        : prev.map((d) =>
            d.id === id ? { ...d, stage, value: carriesMoney(stage) ? d.value : 0 } : d
          )
    );

    moveDealAction(id, stage);
  }

  async function handleAdd(formData: FormData) {
    setBusy(true);
    try {
      // The action returns an id, not a card: the board shows a contact's name
      // and initials, which live on the contact record rather than the deal
      // now that the link is a foreign key. Inserting a half-built card here
      // would flash a nameless row until the refresh replaced it, so the
      // revalidation the action triggers is what puts the deal on the board.
      await addDealAction(formData);
      setAddOpen(null);
    } finally {
      setBusy(false);
    }
  }

  function handleDelete(id: string) {
    setItems((prev) => prev.filter((d) => d.id !== id));
    deleteDealAction(id);
  }

  async function handlePayment(deal: Deal, formData: FormData) {
    setBusy(true);
    try {
      const res = await recordPaymentAction(deal.id, formData);
      if (res?.error) return res.error;

      const paid = Number(formData.get("amount"));
      const remaining = deal.value - paid;
      const splitId = deal.splitId ?? `local-${deal.id}`;
      const splitTotal = deal.splitTotal ?? deal.value;

      setItems((prev) => {
        const existingWon = prev.find((d) => d.splitId === splitId && isWon(d));

        let next = prev.map((d) =>
          d.id === deal.id ? { ...d, value: remaining, splitId, splitTotal } : d
        );

        if (existingWon) {
          next = next.map((d) => (d.id === existingWon.id ? { ...d, value: d.value + paid } : d));
        } else {
          next = [
            {
              ...deal,
              id: `${deal.id}-paid-local`,
              value: paid,
              stage: "won" as StageId,
              splitId,
              splitTotal,
              wonAt: new Date().toISOString(),
            },
            ...next,
          ];
        }

        return remaining === 0 ? next.filter((d) => d.id !== deal.id) : next;
      });

      setActive(null);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleSetValue(deal: Deal, formData: FormData) {
    setBusy(true);
    try {
      await setDealValueAction(deal.id, formData);
      const value = Math.max(0, Math.round(Number(formData.get("value")) || 0));
      setItems((prev) => prev.map((d) => (d.id === deal.id ? { ...d, value } : d)));
      setActive(null);
    } finally {
      setBusy(false);
    }
  }

  const defaultStage = addOpen && addOpen !== true ? addOpen : "prospect";

  return (
    <div className="mx-auto flex h-[calc(100vh-104px)] max-w-[1600px] animate-fade-up flex-col">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4 pt-1">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Deals Pipeline</h1>
          <p className="mt-1 text-sm text-muted">
            Drag deals across stages. Click one in Negotiations to record a payment.
          </p>
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"
        >
          <Plus className="h-[16px] w-[16px]" /> Add Deal
        </button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 @min-[880px]:grid-cols-4">
        <SummaryTile
          icon={<Wallet className="h-5 w-5" />}
          label="Open Pipeline"
          sub="Proposals out"
          value={fullMoney(summary.proposals)}
          tone="var(--amber)"
          soft="var(--amber-soft)"
        />
        <SummaryTile
          icon={<HandCoins className="h-5 w-5" />}
          label="Negotiations Owed"
          sub="Invoiced, awaiting payment"
          value={fullMoney(summary.owed)}
          tone={PARTIAL}
          soft="rgba(249,115,22,0.12)"
        />
        <SummaryTile
          icon={<Coins className="h-5 w-5" />}
          label="Closed Won"
          sub="Money received"
          value={fullMoney(summary.won)}
          tone="var(--green)"
          soft="var(--green-soft)"
        />
        <SummaryTile
          icon={<GripVertical className="h-5 w-5" />}
          label="Total Deals"
          sub="Across all stages"
          value={String(summary.count)}
          tone="var(--accent)"
          soft="var(--accent-soft)"
        />
      </div>

      <div className="-mx-1 flex flex-1 scroll-p-2 gap-4 overflow-x-auto px-1 pb-2">
        {STAGES.map((stage) => {
          const stageDeals = items.filter((d) => d.stage === stage.id);
          const total = stageDeals.reduce((s, d) => s + d.value, 0);
          const isOver = overStage === stage.id;
          const showsMoney = carriesMoney(stage.id);

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
              <div className="border-b border-[var(--border)] px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }} />
                    <span className="text-sm font-semibold">{stage.label}</span>
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[11px] font-semibold text-muted"
                      style={{ background: "var(--raise)" }}
                    >
                      {stageDeals.length}
                    </span>
                  </div>
                  {/* No total on the stages that carry no money — a sum of
                      zeroes still reads as "this column is worth nothing". */}
                  {showsMoney && (
                    <span className="text-xs font-semibold" style={{ color: stage.color }}>
                      {money(total)}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-faint">{stage.exit}</p>
              </div>

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
                    onOpen={() => setActive(deal)}
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

      {active && (
        <DealModal
          deal={active}
          busy={busy}
          onClose={() => setActive(null)}
          onPay={(fd) => handlePayment(active, fd)}
          onSetValue={(fd) => handleSetValue(active, fd)}
        />
      )}
    </div>
  );
}

function SummaryTile({
  icon,
  label,
  sub,
  value,
  tone,
  soft,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
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
        <p className="truncate text-[11px] font-medium">{label}</p>
        <p className="truncate text-[10px] text-faint">{sub}</p>
      </div>
    </div>
  );
}

function DealCard({
  deal,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
  onDelete,
}: {
  deal: Deal;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const showsMoney = carriesMoney(deal.stage);
  const partial = isPartiallyPaid(deal);
  const needsValue = showsMoney && deal.value === 0;

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", deal.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={clsx(
        "group cursor-grab rounded-xl border bg-[var(--panel-solid)] p-3 transition-all active:cursor-grabbing",
        partial ? "border-[color:var(--partial)]" : "border-[var(--border)] hover:border-[var(--border-strong)]",
        dragging && "opacity-40"
      )}
      style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.04)", ...({ "--partial": PARTIAL } as React.CSSProperties) }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold leading-snug">{deal.title}</p>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          // Revealed on hover *or* focus. It was hover-only, so a keyboard
          // user tabbed onto an invisible control with nothing to show where
          // they were.
          className="focus-ring shrink-0 rounded text-faint opacity-0 transition-opacity hover:text-[var(--red)] focus-visible:opacity-100 group-hover:opacity-100"
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

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--border)] pt-2.5">
        {showsMoney ? (
          needsValue ? (
            // Arrived from Qualified, which carries no figure. Say what's
            // missing rather than printing a $0 that looks like a valuation.
            <span className="text-xs font-medium text-accent">Set value →</span>
          ) : (
            <span
              className="text-sm font-bold"
              style={{ color: partial ? PARTIAL : isWon(deal) ? "var(--green)" : "var(--text)" }}
            >
              {money(deal.value)}
            </span>
          )
        ) : (
          <span className="text-[11px] text-faint">No value yet</span>
        )}

        {partial ? (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-bold"
            style={{ background: "rgba(249,115,22,0.14)", color: PARTIAL }}
          >
            PART PAID
          </span>
        ) : (
          <span className="text-[11px] text-faint">{deal.closeDate}</span>
        )}
      </div>

      {partial && deal.splitTotal && (
        <p className="mt-1.5 text-[10px] text-faint">
          {fullMoney(deal.value)} of {fullMoney(deal.splitTotal)} received
        </p>
      )}
    </div>
  );
}

/* ---------------- Deal detail: payment / value ---------------- */

function DealModal({
  deal,
  busy,
  onClose,
  onPay,
  onSetValue,
}: {
  deal: Deal;
  busy: boolean;
  onClose: () => void;
  onPay: (formData: FormData) => Promise<string | null>;
  onSetValue: (formData: FormData) => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  // Payment is recorded once a deal has been presented — Discovery or Demo.
  // "Negotiations" was a stage in a pipeline nobody actually ran.
  const canPay = (deal.stage === "demo" || deal.stage === "discovery") && deal.value > 0;
  const canValue = carriesMoney(deal.stage) && !isWon(deal);

  return (
    <Overlay>
      <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="modal-surface relative z-10 w-full max-w-md p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold tracking-tight">{deal.title}</h2>
              <p className="truncate text-xs text-faint">
                {deal.contact} · {deal.company}
              </p>
            </div>
            <button type="button" onClick={onClose} className="shrink-0 text-faint hover:text-[var(--text)]" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          {isPartiallyPaid(deal) && deal.splitTotal && (
            <div className="mb-4 rounded-xl p-3" style={{ background: "rgba(249,115,22,0.10)" }}>
              <p className="text-sm font-semibold" style={{ color: PARTIAL }}>
                Partly paid — {fullMoney(deal.value)} of {fullMoney(deal.splitTotal)}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {`${fullMoney(deal.splitTotal - deal.value)} is still outstanding. Drag it here when it lands and the two merge back into one deal.`}
              </p>
            </div>
          )}

          {canPay && (
            <form
              action={async (formData: FormData) => {
                setError(null);
                const err = await onPay(formData);
                if (err) setError(err);
              }}
              className="rounded-xl border border-[var(--border)] p-4"
            >
              <p className="text-sm font-semibold">Record a payment</p>
              {/* One expression rather than `{value} outstanding` — JSX drops the
                  space between an expression and adjacent text here, which
                  rendered as "$24,000outstanding". */}
              <p className="mt-0.5 text-xs text-muted">
                {`${fullMoney(deal.value)} outstanding. What's received moves to Closed Won; the rest stays here.`}
              </p>

              <label className="mt-3 block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Amount received ($)</span>
                <input
                  name="amount"
                  type="number"
                  min={1}
                  max={deal.value}
                  required
                  autoFocus
                  placeholder={String(deal.value)}
                  className="field-input"
                />
              </label>

              {error && <p className="mt-2 text-xs" style={{ color: "var(--red)" }}>{error}</p>}

              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60"
                >
                  {busy ? "Recording…" : "Record payment"}
                </button>
              </div>
            </form>
          )}

          {canValue && (
            <form action={onSetValue} className={clsx("rounded-xl border border-[var(--border)] p-4", canPay && "mt-3")}>
              <p className="text-sm font-semibold">{deal.value === 0 ? "Set deal value" : "Update deal value"}</p>
              <p className="mt-0.5 text-xs text-muted">
                The quoted amount for this deal.
              </p>
              <label className="mt-3 block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Value ($)</span>
                <input
                  name="value"
                  type="number"
                  min={0}
                  required
                  autoFocus={!canPay}
                  defaultValue={deal.value || undefined}
                  placeholder="10000"
                  className="field-input"
                />
              </label>
              <div className="mt-3 flex justify-end">
                <button
                  type="submit"
                  disabled={busy}
                  className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60"
                >
                  Save value
                </button>
              </div>
            </form>
          )}

          {!canPay && !canValue && (
            <p className="rounded-xl border border-[var(--border)] p-4 text-sm text-muted">
              {deal.stage === "won"
                ? "This deal is settled in full."
                : "Deals in this stage don't carry a value yet — move it to Proposals once you've quoted."}
            </p>
          )}
        </div>
      </div>
    </Overlay>
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
  const [stage, setStage] = useState<StageId>(defaultStage);
  const showsMoney = carriesMoney(stage);

  return (
    <Overlay>
      <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        {/* Opaque — see the note on `.modal-surface`. */}
        <form action={onSubmit} className="modal-surface relative z-10 w-full max-w-md p-6">
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
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Stage</span>
                <select
                  name="stage"
                  value={stage}
                  onChange={(e) => setStage(e.target.value as StageId)}
                  className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel-solid)] px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-[var(--border-strong)]"
                >
                  {STAGES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>

              {/* The value field only exists where a value can. Leaving it
                  enabled on Leads In invited a number the pipeline then had to
                  throw away. */}
              {showsMoney ? (
                <Field name="value" label="Value ($)" type="number" placeholder="10000" />
              ) : (
                <div className="self-end pb-2.5 text-xs text-faint">
                  No value at this stage — added when you quote.
                </div>
              )}
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
    </Overlay>
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
        className="field-input"
      />
    </label>
  );
}
