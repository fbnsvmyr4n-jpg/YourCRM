"use client";

import { useCallback } from "react";
import { useOpenFromQuery } from "@/lib/useOpenFromQuery";

import { useState } from "react";
import { Mail, MapPin, MoreHorizontal, Pencil, Phone, Plus, Trash2, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { SourceIcon } from "@/components/ui/SourceIcon";
import type { LeadCard } from "@/data/leads";
import { clsx } from "@/lib/clsx";
import { addLeadAction, deleteLeadAction, updateLeadAction } from "./actions";

type ModalState = null | "new" | LeadCard;

export function LeadCardsSection({ leads }: { leads: LeadCard[] }) {
  const [modal, setModal] = useState<ModalState>(null);
  // Arriving from the dashboard Quick Action opens the form directly.
  useOpenFromQuery("new", useCallback(() => setModal("new"), []));
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(formData: FormData) {
    setBusy(true);
    try {
      if (modal === "new") await addLeadAction(formData);
      else if (modal) await updateLeadAction(modal.id, formData);
      setModal(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    setOpenMenu(null);
    if (!confirm("Delete this lead? This can't be undone.")) return;
    setBusy(true);
    try {
      await deleteLeadAction(id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">All Leads</h2>
        <button
          onClick={() => setModal("new")}
          className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold"
        >
          <Plus className="h-[16px] w-[16px]" /> Add Lead
        </button>
      </div>

      {leads.length === 0 ? (
        <div className="card grid place-items-center p-10 text-center">
          <p className="text-muted">No leads yet.</p>
          <button onClick={() => setModal("new")} className="btn-accent mt-4 rounded-xl px-5 py-2.5 text-sm font-semibold">
            Add your first lead
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {leads.map((lead) => (
            <LeadCardItem
              key={lead.id}
              lead={lead}
              menuOpen={openMenu === lead.id}
              onMenuToggle={() => setOpenMenu((v) => (v === lead.id ? null : lead.id))}
              onEdit={() => {
                setOpenMenu(null);
                setModal(lead);
              }}
              onDelete={() => handleDelete(lead.id)}
            />
          ))}
        </div>
      )}

      {openMenu && <div className="fixed inset-0 z-20" onClick={() => setOpenMenu(null)} />}
      {modal !== null && (
        <LeadModal
          lead={modal === "new" ? undefined : modal}
          busy={busy}
          onClose={() => setModal(null)}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}

function LeadCardItem({
  lead,
  menuOpen,
  onMenuToggle,
  onEdit,
  onDelete,
}: {
  lead: LeadCard;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const closed = lead.status === "Closed";
  return (
    <div className="card relative p-5">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Avatar initials={lead.initials} color={lead.color} size="lg" />
          <p className="text-base font-semibold">{lead.name}</p>
        </div>
        <div className="relative">
          <button onClick={onMenuToggle} className="focus-ring text-faint transition-colors hover:text-[var(--text)]" aria-label="Lead actions">
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-7 z-30 w-32 overflow-hidden rounded-xl border border-[var(--border)] py-1 shadow-lg" style={{ background: "var(--panel-solid)" }}>
              <button onClick={onEdit} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--raise)]">
                <Pencil className="h-4 w-4 text-accent" /> Edit
              </button>
              <button onClick={onDelete} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red hover:bg-[var(--raise)]">
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-2 text-sm text-muted">
        <p className="flex items-center gap-2.5">
          <Mail className="h-4 w-4 shrink-0 text-faint" />
          <span className="truncate">{lead.email || "—"}</span>
        </p>
        <p className="flex items-center gap-2.5">
          <Phone className="h-4 w-4 shrink-0 text-faint" />
          {lead.phone || "—"}
        </p>
        <p className="flex items-center gap-2.5">
          <MapPin className="h-4 w-4 shrink-0 text-faint" />
          {lead.location}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-[var(--border)] pt-4">
        <Field label="Project Info">
          <span className="truncate text-accent">{lead.company || "—"}</span>
        </Field>
        <Field label="Status">
          <span className="flex items-center gap-1.5" style={{ color: closed ? "var(--green)" : "var(--red)" }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: closed ? "var(--green)" : "var(--red)" }} />
            <span className="truncate">{closed ? "Closed" : "Follow-up"}</span>
          </span>
        </Field>
        <Field label="Source">
          <span className="flex items-center gap-1.5 text-[var(--text)]">
            <SourceIcon source={lead.source} />
            <span className="truncate">{lead.source}</span>
          </span>
        </Field>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 leading-tight">
      <p className="mb-1 text-[11px] text-faint">{label}</p>
      <div className="flex items-center text-xs font-medium">{children}</div>
    </div>
  );
}

/* ---------------- Add / Edit Lead modal ---------------- */

function LeadModal({
  lead,
  busy,
  onClose,
  onSubmit,
}: {
  lead?: LeadCard;
  busy: boolean;
  onClose: () => void;
  onSubmit: (formData: FormData) => void | Promise<void>;
}) {
  const editing = !!lead;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <form action={onSubmit} className="card relative z-10 w-full max-w-lg overflow-y-auto p-6" style={{ maxHeight: "90vh" }}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">{editing ? "Edit Lead" : "Add Lead"}</h2>
          <button type="button" onClick={onClose} className="text-faint hover:text-[var(--text)]" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ModalField name="name" label="Name" required autoFocus className="sm:col-span-2" defaultValue={lead?.name} />
          <ModalField name="email" label="Email" type="email" className="sm:col-span-2" defaultValue={lead?.email} />
          <ModalField name="phone" label="Phone" defaultValue={lead?.phone} />
          <ModalField name="location" label="Location" defaultValue={lead?.location} />
          <ModalField name="company" label="Company (Project Info)" className="sm:col-span-2" defaultValue={lead?.company} />
          <ModalSelect name="status" label="Status" options={["Follow-up Required", "Closed"]} defaultValue={lead?.status} />
          <ModalSelect name="source" label="Source" options={["Google Ads", "Facebook", "Referral"]} defaultValue={lead?.source} />
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="btn-soft focus-ring rounded-xl px-5 py-2.5 text-sm font-medium">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60">
            {busy ? "Saving…" : editing ? "Save Changes" : "Save Lead"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ModalField({
  name,
  label,
  type = "text",
  required,
  autoFocus,
  className,
  defaultValue,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  autoFocus?: boolean;
  className?: string;
  defaultValue?: string;
}) {
  return (
    <label className={clsx("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-muted">
        {label}
        {required && <span className="text-[var(--red)]"> *</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        autoFocus={autoFocus}
        defaultValue={defaultValue}
        className="field-input"
      />
    </label>
  );
}

function ModalSelect({
  name,
  label,
  options,
  defaultValue,
}: {
  name: string;
  label: string;
  options: string[];
  defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue ?? options[0]}
        className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel-solid)] px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-[var(--border-strong)]"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
