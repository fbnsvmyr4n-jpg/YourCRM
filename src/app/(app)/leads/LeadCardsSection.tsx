"use client";

import { useCallback, useMemo } from "react";
import { useOpenFromQuery } from "@/lib/useOpenFromQuery";
import { SortMenu } from "@/components/ui/SortMenu";

import { useState } from "react";
import { Mail, MapPin, MoreHorizontal, Pencil, Phone, Plus, Trash2, Users, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Overlay } from "@/components/ui/Overlay";
import { SourceIcon } from "@/components/ui/SourceIcon";
import { LEAD_STATUSES, STATUS_TONE, type LeadCard, type LeadStatus } from "@/data/leads";
import { clsx } from "@/lib/clsx";
import { addLeadAction, deleteLeadAction, updateLeadAction } from "./actions";

type ModalState = null | "new" | LeadCard;

/**
 * How the lead cards can be ordered.
 *
 * Newest first by default — a lead nobody has called yet is the one that
 * matters, and it is the one that just arrived. Source is here because "where
 * did these come from" is a question the cards can answer at a glance once they
 * are grouped by it.
 */
const LEAD_SORTS = [
  { id: "newest", label: "Newest first" },
  { id: "name", label: "Name (A–Z)" },
  { id: "company", label: "Company" },
  { id: "source", label: "Source" },
] as const;
type LeadSort = (typeof LEAD_SORTS)[number]["id"];

export function LeadCardsSection({ leads }: { leads: LeadCard[] }) {
  const [modal, setModal] = useState<ModalState>(null);
  // Arriving from the dashboard Quick Action opens the form directly.
  useOpenFromQuery("new", useCallback(() => setModal("new"), []));
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"All" | LeadStatus>("All");
  const [sort, setSort] = useState<LeadSort>("newest");

  const counts = {
    All: leads.length,
    ...Object.fromEntries(
      LEAD_STATUSES.map((st) => [st, leads.filter((l) => l.status === st).length])
    ),
  } as Record<"All" | LeadStatus, number>;

  const visible = useMemo(() => {
    const byStatus = filter === "All" ? leads : leads.filter((l) => l.status === filter);
    // Copied before sorting: `sort` mutates, and this array comes from props.
    const out = [...byStatus];
    switch (sort) {
      case "name":
        return out.sort((a, b) => a.name.localeCompare(b.name));
      case "company":
        // Leads with no company sink rather than sorting under "" at the top,
        // where they push everything else out of view.
        return out.sort((a, b) => {
          if (!a.company && !b.company) return a.name.localeCompare(b.name);
          if (!a.company) return 1;
          if (!b.company) return -1;
          return a.company.localeCompare(b.company) || a.name.localeCompare(b.name);
        });
      case "source":
        return out.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
      case "newest":
      default:
        return out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    }
  }, [leads, filter, sort]);

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
    // This said "This can't be undone", which was simply untrue — the delete
    // beneath it has been soft for weeks. A false warning is worse than none:
    // it stops somebody looking for a record that was there all along.
    if (
      !confirm(
        "Delete this lead? You can put it back from Settings → Recently deleted."
      )
    )
      return;
    setBusy(true);
    try {
      await deleteLeadAction(id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5">
      {/* These four were static headings that counted leads but did nothing.
          They are the natural place to filter from, so they now do. */}
      <div className="mb-5 grid grid-cols-2 gap-4 @min-[880px]:grid-cols-4">
        {(["All", ...LEAD_STATUSES] as const).map((st) => {
          const active = filter === st;
          const tone = st === "All" ? null : STATUS_TONE[st];
          const color = tone?.color ?? "var(--text-muted)";
          const soft = tone?.soft ?? "var(--raise)";
          const label = st === "All" ? "All Leads" : st;

          return (
            <button
              key={st}
              onClick={() => setFilter(st)}
              aria-pressed={active}
              className={clsx(
                "card focus-ring flex items-center justify-between gap-3 p-5 text-left transition-all",
                active ? "ring-2" : "hover:-translate-y-0.5"
              )}
              style={{
                background: `linear-gradient(135deg, ${soft}, transparent 90%)`,
                ...(active ? ({ "--tw-ring-color": color } as React.CSSProperties) : {}),
              }}
            >
              <span className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style={{ background: soft }}>
                  <Users className="h-5 w-5" style={{ color }} />
                </span>
                <span className="leading-tight">
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className="block text-xs text-faint">
                    {active ? "Showing these" : "Tap to filter"}
                  </span>
                </span>
              </span>
              <span className="text-3xl font-bold tabular-nums" style={{ color }}>
                {String(counts[st] ?? 0).padStart(2, "0")}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">
          {filter === "All" ? "All Leads" : filter}
          <span className="ml-2 text-sm font-normal text-faint">{visible.length}</span>
        </h2>
        <div className="flex items-center gap-2">
          <SortMenu options={LEAD_SORTS} value={sort} onChange={setSort} defaultId="newest" />
          <button
            onClick={() => setModal("new")}
            className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold"
          >
            <Plus className="h-[16px] w-[16px]" /> Add Lead
          </button>
        </div>
      </div>

      {leads.length === 0 ? (
        <div className="card grid place-items-center p-10 text-center">
          <p className="text-muted">No leads yet.</p>
          <button onClick={() => setModal("new")} className="btn-accent mt-4 rounded-xl px-5 py-2.5 text-sm font-semibold">
            Add your first lead
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="card grid place-items-center p-10 text-center">
          <p className="text-muted">No leads with this status.</p>
          <button onClick={() => setFilter("All")} className="btn-soft mt-4 rounded-xl px-5 py-2.5 text-sm font-semibold">
            Show all leads
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 @min-[560px]:grid-cols-2 @min-[900px]:grid-cols-3">
          {visible.map((lead) => (
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

      {/* Click-away catcher. Portalled for the same reason as the dialogs: it
          has to cover the whole window, including the parts `<main>` doesn't. */}
      {openMenu && (
        <Overlay>
          <div className="fixed inset-0 z-20" onClick={() => setOpenMenu(null)} />
        </Overlay>
      )}
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
  const tone = STATUS_TONE[lead.status] ?? { color: "var(--text-muted)", soft: "var(--raise)" };
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
        {/* `min-w-0` on the flex wrapper is load-bearing: a flex item defaults
            to `min-width: auto`, so it refuses to shrink below its content and
            the `truncate` on the child never engages. Without it the status ran
            26px past its own column and 18px into Source — visible as soon as
            the label grew from "Follow-up" to "Follow-up Required". */}
        <Field label="Status">
          <span className="flex min-w-0 items-center gap-1.5" style={{ color: tone.color }} title={lead.status}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone.color }} />
            <span className="truncate">{lead.status}</span>
          </span>
        </Field>
        <Field label="Source">
          <span className="flex min-w-0 items-center gap-1.5 text-[var(--text)]" title={lead.source}>
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
    <Overlay>
      <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <form action={onSubmit} className="modal-surface relative z-10 w-full max-w-lg overflow-y-auto p-6" style={{ maxHeight: "90vh" }}>
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
            <ModalSelect name="source" label="Source" options={["Google Ads", "Facebook", "Referral", "Phone Call"]} defaultValue={lead?.source} />
          </div>

          {/* No status field. It used to be chosen here, which meant declaring an
              outcome for a lead nothing had happened to yet. It now follows the
              record: a call or meeting moves it to Follow-up Required, a win
              moves it to Closed Won. */}
          <p className="mt-4 rounded-xl px-3 py-2 text-xs text-muted" style={{ background: "var(--raise)" }}>
            {editing
              ? `Status is ${lead?.status ?? "New Lead"} — set automatically from calls, meetings and deals.`
              : "Saved as a New Lead. It moves to Follow-up Required after a call or meeting, and to Closed Won when the deal lands."}
          </p>

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
    </Overlay>
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
