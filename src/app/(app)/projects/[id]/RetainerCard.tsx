"use client";

import { useState } from "react";
import { Pause, Play, Repeat, X } from "lucide-react";
import { Banner } from "@/components/ui/Banner";
import { Card, CardHeader } from "@/components/ui/Card";
import { useMoney } from "@/components/money/CurrencyProvider";
import { useFormDisclosure } from "@/lib/form-disclosure";
import { useKeptForm } from "@/lib/use-kept-form";
import { clsx } from "@/lib/clsx";
import { dayLabel, EVERY_LABEL, RETAINER_EVERY, type Retainer } from "@/server/retainer-rules";
import {
  createRetainerAction,
  setRetainerStatusAction,
  updateRetainerAction,
  type FormState,
} from "../actions";

/**
 * Billing a client the same amount on a schedule.
 *
 * Small on purpose: most projects will never have one, so the empty state is a
 * single line rather than a form taking a screen. Each invoice is raised as a
 * DRAFT on its date and shows up in the documents below and in the bell —
 * sending it stays a person's decision, the same as every other invoice.
 */
export function RetainerCard({ dealId, retainers, today }: { dealId: string; retainers: Retainer[]; today: string }) {
  const create = useKeptForm<FormState>(createRetainerAction, undefined);
  const createState = create.state;
  const { state: statusState, onSubmit: setStatus, pending: settingStatus } = useKeptForm<FormState>(setRetainerStatusAction, undefined);
  const [open, openForm, closeForm] = useFormDisclosure(createState, (s) => Boolean(s?.ok));

  const live = retainers.filter((r) => r.status !== "cancelled");
  const ended = retainers.length - live.length;

  return (
    <Card>
      <CardHeader
        title="Retainer"
        icon={<Repeat className="h-[18px] w-[18px] text-accent" />}
        action={
          !open && (
            <button
              type="button"
              onClick={openForm}
              className={clsx(
                "focus-ring flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold",
                live.length ? "btn-soft" : "btn-accent"
              )}
            >
              {live.length ? "Add another" : "Set up"}
            </button>
          )
        }
      />

      <div className="flex flex-col gap-2 empty:hidden">
        {/* The latest word only: a "set up" message still showing after a
            pause reads as though the pause did not happen. */}
        {statusState ? <Banner state={statusState} /> : !open && <Banner state={createState} />}
      </div>

      {open && (
        <RetainerForm dealId={dealId} today={today} form={create} onCancel={closeForm} />
      )}

      {!open && live.length === 0 && (
        <p className="text-xs text-faint">
          Bill this client the same amount every month, quarter or year. Each invoice is drafted on its date for you
          to check and send.
          {ended > 0 && ` ${ended} earlier retainer${ended === 1 ? " has" : "s have"} ended.`}
        </p>
      )}

      <div className="flex flex-col gap-3">
        {live.map((r) => (
          <RetainerRow key={r.id} retainer={r} today={today} onStatus={setStatus} busy={settingStatus} />
        ))}
      </div>
    </Card>
  );
}

function RetainerRow({
  retainer: r,
  today,
  onStatus,
  busy,
}: {
  retainer: Retainer;
  today: string;
  onStatus: React.FormEventHandler<HTMLFormElement>;
  busy: boolean;
}) {
  const { format } = useMoney();
  const edit = useKeptForm<FormState>(updateRetainerAction, undefined);
  const editState = edit.state;
  const [isEditing, openEdit, closeEdit] = useFormDisclosure(editState, (s) => Boolean(s?.ok));
  const [confirmCancel, setConfirmCancel] = useState(false);
  const paused = r.status === "paused";
  const finished = r.endsOn !== null && r.nextInvoiceOn > r.endsOn;

  if (isEditing) {
    return (
      <RetainerForm dealId={r.dealId} today={today} retainer={r} form={edit} onCancel={closeEdit} />
    );
  }

  const statusForm = (to: string, label: React.ReactNode, className?: string) => (
    <form onSubmit={onStatus}>
      <input type="hidden" name="retainerId" value={r.id} />
      <input type="hidden" name="to" value={to} />
      <button
        type="submit"
        disabled={busy}
        className={clsx("btn-soft focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-60", className)}
      >
        {label}
      </button>
    </form>
  );

  return (
    <div className="rounded-xl border border-[var(--border)] p-3.5">
      <Banner state={editState} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-sm font-semibold">{r.description}</p>
        <p className="text-sm font-semibold tabular-nums">
          {format(r.amountCents, "exact")}
          <span className="font-normal text-faint"> / {EVERY_LABEL[r.every]}</span>
        </p>
      </div>
      <p className="mt-1 text-xs text-muted">
        {paused ? (
          <span style={{ color: "var(--amber)" }}>Paused — nothing is billed until it is resumed</span>
        ) : finished ? (
          <>Ended {dayLabel(r.endsOn!)} — every period has been billed</>
        ) : (
          <>
            Next invoice {dayLabel(r.nextInvoiceOn)} · due {r.dueDays === 0 ? "on receipt" : `in ${r.dueDays} days`}
            {r.endsOn && ` · until ${dayLabel(r.endsOn)}`}
          </>
        )}
      </p>
      <p className="mt-0.5 text-[11px] text-faint">
        Since {dayLabel(r.startsOn)} · {r.periodsBilled} {r.periodsBilled === 1 ? "invoice" : "invoices"} raised
      </p>

      {confirmCancel ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted">Cancel for good? Invoices already raised stay on the project.</p>
          <button type="button" onClick={() => setConfirmCancel(false)} className="btn-soft focus-ring rounded-lg px-2.5 py-1.5 text-xs font-medium">
            Keep it
          </button>
          {statusForm("cancelled", "Cancel retainer", "text-red")}
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={openEdit} className="btn-soft focus-ring rounded-lg px-2.5 py-1.5 text-xs font-medium">
            Edit
          </button>
          {!finished &&
            (paused
              ? statusForm("active", <><Play className="h-3.5 w-3.5" /> Resume</>)
              : statusForm("paused", <><Pause className="h-3.5 w-3.5" /> Pause</>))}
          <button
            type="button"
            onClick={() => setConfirmCancel(true)}
            className="focus-ring ml-auto flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-faint hover:text-[var(--red)]"
          >
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function RetainerForm({
  dealId,
  today,
  retainer,
  form,
  onCancel,
}: {
  dealId: string;
  today: string;
  retainer?: Retainer;
  form: ReturnType<typeof useKeptForm<FormState>>;
  onCancel: () => void;
}) {
  const { state, pending, formProps } = form;
  const { symbol } = useMoney();
  const editing = Boolean(retainer);
  return (
    <form {...formProps} className="mb-3 space-y-3 rounded-xl border border-[var(--border)] p-3.5">
      <Banner state={state} />
      <input type="hidden" name="dealId" value={dealId} />
      {retainer && <input type="hidden" name="retainerId" value={retainer.id} />}

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">What it is for</span>
        <input
          name="description"
          required
          maxLength={200}
          defaultValue={retainer?.description}
          placeholder="Monthly garden maintenance"
          className="field-input"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Amount ({symbol})</span>
          <input
            name="amount"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            required
            defaultValue={retainer ? (retainer.amountCents / 100).toFixed(2) : undefined}
            className="field-input"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Billed every</span>
          {/* Fixed once set: changing the rhythm of a running retainer would
              re-draw every period already billed. Cancel and start another. */}
          {retainer ? (
            <>
              <input type="hidden" name="every" value={retainer.every} />
              <p className="field-input capitalize text-muted">{EVERY_LABEL[retainer.every]}</p>
            </>
          ) : (
            <select name="every" defaultValue="month" className="field-input">
              {RETAINER_EVERY.map((e) => (
                <option key={e} value={e}>
                  {EVERY_LABEL[e][0].toUpperCase() + EVERY_LABEL[e].slice(1)}
                </option>
              ))}
            </select>
          )}
        </label>
      </div>

      {/* One column on a phone: two date pickers side by side at that width
          cut the date off mid-number. */}
      <div className="grid grid-cols-1 gap-3 @min-[520px]:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">First invoice</span>
          {retainer ? (
            <>
              <input type="hidden" name="startsOn" value={retainer.startsOn} />
              <p className="field-input text-muted">{dayLabel(retainer.startsOn)}</p>
            </>
          ) : (
            <input name="startsOn" type="date" required defaultValue={today} className="field-input" />
          )}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Payment due (days)</span>
          <input
            name="dueDays"
            type="number"
            min="0"
            max="120"
            step="1"
            defaultValue={retainer?.dueDays ?? 7}
            className="field-input"
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Ends (optional)</span>
        <input name="endsOn" type="date" defaultValue={retainer?.endsOn ?? ""} className="field-input" />
      </label>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-medium">
          Cancel
        </button>
        <button type="submit" disabled={pending} className="btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60">
          {pending ? "Saving…" : editing ? "Save" : "Start retainer"}
        </button>
      </div>
    </form>
  );
}
