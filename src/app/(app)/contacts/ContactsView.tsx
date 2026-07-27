"use client";

import { useState } from "react";
import {
  Building2,
  Calendar,
  Camera,
  ChevronDown,
  ChevronRight,
  Copy,
  DollarSign,
  Filter,
  Landmark,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  StickyNote,
  Trash2,
  User,
  UserRound,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import type { Contact, ContactType } from "@/data/contacts";
import { clsx } from "@/lib/clsx";
import { addContactAction, deleteContactAction, updateContactAction } from "./actions";

/** null = closed, "new" = add mode, Contact = edit mode */
type ModalState = null | "new" | Contact;

export function ContactsView({ contacts }: { contacts: Contact[] }) {
  const [selectedId, setSelectedId] = useState(contacts[0]?.id ?? "");
  const [tab, setTab] = useState<"email" | "call" | "note">("email");
  const [modal, setModal] = useState<ModalState>(null);
  const [busy, setBusy] = useState(false);

  const contact = contacts.find((c) => c.id === selectedId) ?? contacts[0];

  async function handleSubmit(formData: FormData) {
    setBusy(true);
    try {
      if (modal === "new") {
        const newId = await addContactAction(formData);
        if (newId) setSelectedId(newId);
      } else if (modal) {
        await updateContactAction(modal.id, formData);
      }
      setModal(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this contact? This can't be undone.")) return;
    setBusy(true);
    try {
      await deleteContactAction(id);
      const remaining = contacts.filter((c) => c.id !== id);
      setSelectedId(remaining[0]?.id ?? "");
    } finally {
      setBusy(false);
    }
  }

  const modalEl =
    modal !== null ? (
      <ContactModal
        contact={modal === "new" ? undefined : modal}
        onClose={() => setModal(null)}
        onSubmit={handleSubmit}
        busy={busy}
      />
    ) : null;

  if (!contact) {
    return (
      <div className="grid h-[calc(100vh-104px)] place-items-center">
        <div className="text-center">
          <p className="text-muted">No contacts yet.</p>
          <button onClick={() => setModal("new")} className="btn-accent mt-4 rounded-xl px-5 py-2.5 text-sm font-semibold">
            Add your first contact
          </button>
        </div>
        {modalEl}
      </div>
    );
  }

  return (
    <div className="mx-auto grid h-auto max-w-[1500px] animate-fade-up grid-cols-1 gap-4 lg:h-[calc(100vh-104px)] lg:grid-cols-[290px_minmax(0,1fr)_326px]">
      <InfoPanel contact={contact} tab={tab} setTab={setTab} />
      <ProfilePanel
        contact={contact}
        onEdit={() => setModal(contact)}
        onDelete={() => handleDelete(contact.id)}
        busy={busy}
      />
      <ContactsList
        contacts={contacts}
        selectedId={contact.id}
        onSelect={setSelectedId}
        onAdd={() => setModal("new")}
      />
      {modalEl}
    </div>
  );
}

/* ---------------- LEFT: info panel ---------------- */

function InfoPanel({
  contact,
  tab,
  setTab,
}: {
  contact: Contact;
  tab: "email" | "call" | "note";
  setTab: (t: "email" | "call" | "note") => void;
}) {
  const tabs = [
    { id: "email" as const, label: "Email", icon: Mail },
    { id: "call" as const, label: "Call", icon: Phone },
    { id: "note" as const, label: "Note", icon: StickyNote },
  ];
  return (
    <aside className="card flex flex-col gap-5 overflow-y-auto p-5">
      <div className="grid grid-cols-3 gap-2">
        {tabs.map((t) => {
          const active = tab === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={clsx(
                "focus-ring flex flex-col items-center gap-1.5 rounded-xl border py-2.5 text-xs font-medium transition-colors",
                active
                  ? "border-[var(--border-strong)] text-accent"
                  : "border-[var(--border)] text-muted hover:text-[var(--text)]"
              )}
              style={active ? { background: "var(--accent-soft)" } : undefined}
            >
              <Icon className="h-[18px] w-[18px]" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Status</p>
        <button className="btn-soft focus-ring flex w-full items-center justify-between rounded-xl px-3.5 py-3 text-sm">
          <span className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--green)]" />
            {contact.status}
          </span>
          <ChevronDown className="h-4 w-4 text-faint" />
        </button>
      </div>

      <Section title="Personal Information">
        <InfoRow icon={User} label="First Name" value={contact.firstName} />
        <InfoRow icon={UserRound} label="Last Name" value={contact.lastName} />
        <InfoRow
          icon={UserRound}
          label={contact.type === "lead" ? "Lead Name" : "Client Name"}
          value={`${contact.firstName} ${contact.lastName}`}
        />
      </Section>

      <Section title="Company">
        <InfoRow icon={Building2} label="Company" value={contact.company} />
        <InfoRow icon={Landmark} label="Company Info" value={contact.companyInfo} />
      </Section>

      <Section title="Contact Information">
        <InfoRow icon={Mail} label="Email" value={contact.email} />
        <InfoRow icon={Phone} label="Phone / WhatsApp" value={contact.phone} />
        <InfoRow icon={User} label="Contact Owner" value={contact.owner} />
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-3 border-t border-[var(--border)] pt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        {title}
      </p>
      <div className="space-y-3.5">{children}</div>
    </div>
  );
}

function InfoRow({ icon: Icon, label, value }: { icon: typeof User; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: "var(--accent-soft)" }}>
        <Icon className="h-[16px] w-[16px] text-accent" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] text-faint">{label}</p>
        <p className="truncate text-sm font-medium">{value || "—"}</p>
      </div>
    </div>
  );
}

/* ---------------- CENTER: profile ---------------- */

function ProfilePanel({
  contact,
  onEdit,
  onDelete,
  busy,
}: {
  contact: Contact;
  onEdit: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const actions = [
    { icon: Phone, label: "Call" },
    { icon: MessageCircle, label: "Text" },
    { icon: Mail, label: "Email" },
    { icon: DollarSign, label: "Revenue" },
    { icon: StickyNote, label: "Note" },
    { icon: MoreHorizontal, label: "More" },
  ];

  return (
    <section className="card flex flex-col overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <div className="mx-auto flex w-full max-w-[320px] rounded-full border border-[var(--border)] p-1">
          {(["client", "lead"] as ContactType[]).map((t) => {
            const active = contact.type === t;
            return (
              <div
                key={t}
                className={clsx(
                  "flex flex-1 items-center justify-center gap-2 rounded-full py-2 text-sm font-medium capitalize transition-colors",
                  active ? "text-accent" : "text-faint"
                )}
                style={active ? { background: "var(--accent-soft)" } : undefined}
              >
                {t === "client" ? <User className="h-4 w-4" /> : <Building2 className="h-4 w-4" />}
                {t}
              </div>
            );
          })}
        </div>
        <div className="ml-2 flex shrink-0 items-center gap-1">
          <button
            onClick={onEdit}
            disabled={busy}
            className="focus-ring grid h-9 w-9 place-items-center rounded-full text-faint transition-colors hover:text-accent disabled:opacity-50"
            aria-label="Edit contact"
          >
            <Pencil className="h-[17px] w-[17px]" />
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="focus-ring grid h-9 w-9 place-items-center rounded-full text-faint transition-colors hover:text-[var(--red)] disabled:opacity-50"
            aria-label="Delete contact"
          >
            <Trash2 className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>

      <div className="relative mx-auto mt-8 mb-4">
        <div className="galaxy grid h-44 w-44 place-items-center rounded-full">
          <span className="accent-text text-6xl font-bold tracking-tight">{contact.initials}</span>
        </div>
        <button
          className="focus-ring absolute -bottom-1 left-1/2 grid h-10 w-10 -translate-x-1/2 place-items-center rounded-full border border-[var(--border-strong)]"
          style={{ background: "var(--panel-solid)" }}
          aria-label="Change photo"
        >
          <Camera className="h-[18px] w-[18px] text-muted" />
        </button>
      </div>

      <h1 className="mt-4 text-center text-3xl font-bold tracking-tight">
        {contact.firstName} {contact.lastName}
      </h1>

      <div className="mx-auto mt-4 flex w-full max-w-[360px] items-center justify-between gap-3 rounded-xl border border-[var(--border)] px-4 py-3">
        <span className="truncate text-sm text-muted">{contact.email || "No email"}</span>
        <button className="focus-ring text-faint transition-colors hover:text-accent" aria-label="Copy email">
          <Copy className="h-4 w-4" />
        </button>
      </div>

      <div className="mx-auto mt-6 grid w-full max-w-[440px] grid-cols-6 gap-2">
        {actions.map((a) => {
          const Icon = a.icon;
          return (
            <button key={a.label} className="focus-ring group flex flex-col items-center gap-1.5">
              <span className="btn-soft grid h-12 w-12 place-items-center rounded-full transition-transform group-hover:-translate-y-0.5">
                <Icon className="h-[19px] w-[19px] text-accent" />
              </span>
              <span className="text-[11px] text-muted">{a.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-7 rounded-2xl border border-[var(--border)] p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Contact Activity</h3>
            <span className="mt-1.5 block h-0.5 w-10 rounded-full accent-gradient" />
          </div>
          <MoreHorizontal className="h-5 w-5 text-faint" />
        </div>

        <div className="mt-5 space-y-3">
          {contact.activity.map((a, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <span className="text-sm">{a.title}</span>
              <span className="flex shrink-0 items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-xs text-muted">
                <Calendar className="h-3.5 w-3.5 text-accent" />
                {a.date}
              </span>
            </div>
          ))}
        </div>

        <button className="btn-accent focus-ring mt-5 ml-auto flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold">
          <Calendar className="h-4 w-4" />
          Date + Time
        </button>
      </div>
    </section>
  );
}

/* ---------------- RIGHT: contacts list ---------------- */

function ContactsList({
  contacts,
  selectedId,
  onSelect,
  onAdd,
}: {
  contacts: Contact[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <aside className="card flex flex-col overflow-hidden p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Contacts</h2>
        <div className="flex items-center gap-2">
          <IconBtn label="Sort">
            <ChevronDown className="h-4 w-4" />
          </IconBtn>
          <IconBtn label="Filter">
            <Filter className="h-4 w-4" />
          </IconBtn>
          <button onClick={onAdd} className="btn-accent focus-ring grid h-9 w-9 place-items-center rounded-full" aria-label="Add contact">
            <Plus className="h-[18px] w-[18px]" />
          </button>
        </div>
      </div>

      <div className="-mr-2 flex flex-1 flex-col gap-2 overflow-y-auto pr-2">
        {contacts.map((c) => {
          const active = c.id === selectedId;
          const isLead = c.type === "lead";
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={clsx(
                "focus-ring flex items-center gap-3 rounded-2xl border p-3 text-left transition-colors",
                active ? "border-[var(--border-strong)]" : "border-[var(--border)] hover:border-[var(--border-strong)]"
              )}
              style={active ? { background: "var(--accent-soft)" } : undefined}
            >
              <Avatar initials={c.initials} color={c.color} />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-sm font-semibold">
                  {c.firstName} {c.lastName}
                </p>
                <p className="truncate text-xs text-faint">{c.info}</p>
              </div>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide"
                style={{
                  background: isLead ? "var(--purple-soft)" : "var(--green-soft)",
                  color: isLead ? "var(--purple)" : "var(--green)",
                }}
              >
                {isLead ? "LEAD" : "CLIENT"}
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function IconBtn({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <button className="btn-soft focus-ring grid h-9 w-9 place-items-center rounded-full text-muted" aria-label={label}>
      {children}
    </button>
  );
}

/* ---------------- Add / Edit Contact modal ---------------- */

function ContactModal({
  contact,
  onClose,
  onSubmit,
  busy,
}: {
  contact?: Contact;
  onClose: () => void;
  onSubmit: (formData: FormData) => void | Promise<void>;
  busy: boolean;
}) {
  const editing = !!contact;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <form
        action={onSubmit}
        className="card relative z-10 w-full max-w-lg overflow-y-auto p-6"
        style={{ maxHeight: "90vh" }}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">{editing ? "Edit Contact" : "Add Contact"}</h2>
          <button type="button" onClick={onClose} className="text-faint hover:text-[var(--text)]" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ModalField name="firstName" label="First Name" required autoFocus defaultValue={contact?.firstName} />
          <ModalField name="lastName" label="Last Name" required defaultValue={contact?.lastName} />
          <ModalField name="email" label="Email" type="email" className="sm:col-span-2" defaultValue={contact?.email} />
          <ModalField name="phone" label="Phone / WhatsApp" defaultValue={contact?.phone} />
          <ModalSelect name="type" label="Type" options={["lead", "client"]} defaultValue={contact?.type} />
          <ModalField name="company" label="Company" defaultValue={contact?.company} />
          <ModalSelect
            name="status"
            label="Status"
            options={["New", "Active", "Follow-up", "Inactive"]}
            defaultValue={contact?.status}
          />
          <ModalField name="companyInfo" label="Company Info" className="sm:col-span-2" defaultValue={contact?.companyInfo} />
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="btn-soft focus-ring rounded-xl px-5 py-2.5 text-sm font-medium">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="btn-accent focus-ring rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60">
            {busy ? "Saving…" : editing ? "Save Changes" : "Save Contact"}
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
        className="w-full rounded-xl border border-[var(--border)] bg-transparent px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-[var(--border-strong)]"
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
        className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel-solid)] px-3.5 py-2.5 text-sm capitalize outline-none transition-colors focus:border-[var(--border-strong)]"
      >
        {options.map((o) => (
          <option key={o} value={o} className="capitalize">
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
