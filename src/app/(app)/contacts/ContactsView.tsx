"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  Calendar,
  Check,
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
import { Overlay } from "@/components/ui/Overlay";
import { TimeAgo } from "@/components/ui/TimeAgo";
import type { Contact, ContactType } from "@/data/contacts";
import type { ContactSummary, TimelineEntry } from "@/server/contact-timeline";
import { clsx } from "@/lib/clsx";
import {
  addContactAction,
  addNoteAction,
  deleteActivityAction,
  deleteContactAction,
  logOutreachAction,
  updateContactAction,
} from "./actions";

/** null = closed, "new" = add mode, Contact = edit mode */
type ModalState = null | "new" | Contact;
type Panel = null | "note" | "revenue";

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

export function ContactsView({
  contacts,
  summaries,
  currentUser,
}: {
  contacts: Contact[];
  summaries: Record<string, ContactSummary>;
  currentUser: string | null;
}) {
  const [selectedId, setSelectedId] = useState(contacts[0]?.id ?? "");
  const [modal, setModal] = useState<ModalState>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | ContactType>("all");
  const [grouped, setGrouped] = useState(false);

  const contact = contacts.find((c) => c.id === selectedId) ?? contacts[0];
  const summary = contact ? summaries[contact.id] : undefined;

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
    if (!confirm("Delete this contact? Their activity history goes with them.")) return;
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
    <div
      className={clsx(
        "mx-auto grid h-auto max-w-[1500px] animate-fade-up grid-cols-1 gap-4",
        /* Two columns: the picker stays pinned on the right — it is how you move
           between contacts, so it must not drop below the fold — while the
           profile sits above the detail fields in the flexible column. */
        "@min-[700px]:grid-cols-[minmax(0,1fr)_minmax(0,340px)]",
        "@min-[700px]:[grid-template-areas:'profile_list''info_list']",
        /* Three columns, the designed layout. 290 + 380 + 326 + 32px of gaps is
           1028, so this is the first width at which it is honest. The middle
           column carries a real floor: below 380px its six action buttons
           (6 x 48px + gaps) start overlapping each other. */
        "@min-[1030px]:h-[calc(100vh-104px)]",
        "@min-[1030px]:grid-cols-[290px_minmax(380px,1fr)_326px]",
        "@min-[1030px]:[grid-template-areas:'info_profile_list']"
      )}
    >
      <InfoPanel contact={contact} summary={summary} className="@min-[700px]:[grid-area:info]" />
      <ProfilePanel
        className="@min-[700px]:[grid-area:profile]"
        contact={contact}
        summary={summary}
        currentUser={currentUser}
        onEdit={() => setModal(contact)}
        onDelete={() => handleDelete(contact.id)}
        panel={panel}
        setPanel={setPanel}
        busy={busy}
      />
      <ContactsList
        className="@min-[700px]:[grid-area:list]"
        contacts={contacts}
        selectedId={contact.id}
        onSelect={setSelectedId}
        onAdd={() => setModal("new")}
        filter={filter}
        setFilter={setFilter}
        grouped={grouped}
        toggleGrouped={() => setGrouped((g) => !g)}
      />
      {modalEl}
    </div>
  );
}

/* ---------------- LEFT: info panel ---------------- */

const STATUS_TONE: Record<string, { color: string; soft: string }> = {
  Active: { color: "var(--green)", soft: "var(--green-soft)" },
  New: { color: "var(--accent)", soft: "var(--accent-soft)" },
  "Follow-up": { color: "var(--amber)", soft: "var(--amber-soft)" },
  Inactive: { color: "var(--text-faint)", soft: "var(--raise)" },
};

function InfoPanel({
  contact,
  summary,
  className,
}: {
  contact: Contact;
  summary?: ContactSummary;
  className?: string;
}) {
  const tone = STATUS_TONE[contact.status] ?? STATUS_TONE.Inactive;

  return (
    <aside className={clsx("card flex flex-col gap-5 overflow-y-auto p-5", className)}>
      {/* Status is a *reading*, not a control. It was styled as a button with a
          chevron, so people kept clicking it expecting a menu and nothing
          happened. Status is changed in Edit Contact, where the rest of the
          record is edited. */}
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Status</p>
        <div
          className="flex w-full items-center gap-2.5 rounded-xl px-3.5 py-3 text-sm font-medium"
          style={{ background: tone.soft, color: tone.color }}
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: tone.color }} />
          {contact.status}
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-2">
          <MiniStat label="Won" value={money(summary.wonValue)} tone="var(--green)" />
          <MiniStat label="Open" value={money(summary.openValue)} tone="var(--accent)" />
        </div>
      )}

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

function MiniStat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">{label}</p>
      <p className="mt-0.5 text-sm font-bold" style={{ color: tone }}>
        {value}
      </p>
    </div>
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
  summary,
  currentUser,
  onEdit,
  onDelete,
  panel,
  setPanel,
  busy,
  className,
}: {
  contact: Contact;
  summary?: ContactSummary;
  currentUser: string | null;
  onEdit: () => void;
  onDelete: () => void;
  panel: Panel;
  setPanel: (p: Panel) => void;
  busy: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [pending, setPending] = useState(false);

  const tel = contact.phone.replace(/[^\d+]/g, "");

  async function copy(value: string, what: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* clipboard blocked — the value is on screen to copy by hand */
    }
  }

  /**
   * Open the right app, then record that it happened.
   *
   * The href does the opening (a real `tel:` / `sms:` / `mailto:` link, which
   * is the only thing that can hand off to the device's own dialler or mail
   * client). This just logs it, so Contact Activity reflects what was actually
   * done rather than a fixture.
   */
  async function reach(kind: "call" | "text" | "email") {
    setPending(true);
    try {
      await logOutreachAction(contact.id, kind);
    } finally {
      setPending(false);
    }
  }

  const actions = [
    {
      label: "Call",
      icon: Phone,
      href: tel ? `tel:${tel}` : undefined,
      disabled: !tel,
      title: tel ? `Call ${contact.phone}` : "No phone number on file",
      onClick: () => reach("call"),
    },
    {
      label: "Text",
      icon: MessageCircle,
      href: tel ? `sms:${tel}` : undefined,
      disabled: !tel,
      title: tel ? `Text ${contact.phone}` : "No phone number on file",
      onClick: () => reach("text"),
    },
    {
      label: "Email",
      icon: Mail,
      href: contact.email ? `mailto:${contact.email}` : undefined,
      disabled: !contact.email,
      title: contact.email ? `Email ${contact.email}` : "No email address on file",
      onClick: () => reach("email"),
    },
    {
      label: "Revenue",
      icon: DollarSign,
      disabled: false,
      title: "Deals and revenue for this contact",
      onClick: () => setPanel(panel === "revenue" ? null : "revenue"),
    },
    {
      label: "Note",
      icon: StickyNote,
      disabled: false,
      title: "Add a note to this contact's history",
      onClick: () => setPanel(panel === "note" ? null : "note"),
    },
    {
      label: "More",
      icon: MoreHorizontal,
      disabled: false,
      title: "More actions",
      onClick: () => setMore((m) => !m),
    },
  ];

  return (
    <section className={clsx("card flex flex-col overflow-y-auto p-6", className)}>
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
      </div>

      <h1 className="mt-4 text-center text-3xl font-bold tracking-tight">
        {contact.firstName} {contact.lastName}
      </h1>
      <p className="mt-1 text-center text-sm text-faint">{contact.info}</p>

      <div className="mx-auto mt-4 flex w-full max-w-[360px] items-center justify-between gap-3 rounded-xl border border-[var(--border)] px-4 py-3">
        <span className="truncate text-sm text-muted">{contact.email || "No email"}</span>
        <button
          onClick={() => copy(contact.email, "email")}
          disabled={!contact.email}
          className="focus-ring text-faint transition-colors hover:text-accent disabled:opacity-40"
          aria-label="Copy email"
        >
          {copied === "email" ? <Check className="h-4 w-4 text-[var(--green)]" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>

      {/* Six buttons that all did nothing. Call / Text / Email are now real
          links — only an anchor can hand off to the device's dialler or mail
          app — and each records the outreach. Revenue and Note open panels
          below; More opens a menu. */}
      <div className="relative mx-auto mt-6 grid w-full max-w-[440px] grid-cols-6 gap-2">
        {actions.map((a) => {
          const Icon = a.icon;
          const inner = (
            <>
              <span
                className={clsx(
                  "btn-soft grid h-12 w-12 place-items-center rounded-full transition-transform",
                  !a.disabled && "group-hover:-translate-y-0.5"
                )}
              >
                <Icon className={clsx("h-[19px] w-[19px]", a.disabled ? "text-faint" : "text-accent")} />
              </span>
              <span className={clsx("text-[11px]", a.disabled ? "text-faint" : "text-muted")}>{a.label}</span>
            </>
          );

          return a.href ? (
            <a
              key={a.label}
              href={a.href}
              onClick={a.onClick}
              title={a.title}
              className="focus-ring group flex flex-col items-center gap-1.5"
            >
              {inner}
            </a>
          ) : (
            <button
              key={a.label}
              type="button"
              onClick={a.onClick}
              disabled={a.disabled || pending}
              title={a.title}
              className="focus-ring group flex flex-col items-center gap-1.5 disabled:cursor-not-allowed"
            >
              {inner}
            </button>
          );
        })}

        {more && (
          <MoreMenu
            contact={contact}
            onClose={() => setMore(false)}
            onEdit={() => {
              setMore(false);
              onEdit();
            }}
            onCopy={copy}
          />
        )}
      </div>

      {panel === "note" && <NotePanel contactId={contact.id} onDone={() => setPanel(null)} />}
      {panel === "revenue" && <RevenuePanel summary={summary} />}

      <ActivityPanel contact={contact} entries={summary?.timeline ?? []} currentUser={currentUser} />
    </section>
  );
}

function MoreMenu({
  contact,
  onClose,
  onEdit,
  onCopy,
}: {
  contact: Contact;
  onClose: () => void;
  onEdit: () => void;
  onCopy: (value: string, what: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Click-away and Escape, so the menu can't be left stranded open.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const items = [
    { label: "Edit contact", onClick: onEdit, enabled: true },
    { label: "Copy email", onClick: () => onCopy(contact.email, "more-email"), enabled: !!contact.email },
    { label: "Copy phone", onClick: () => onCopy(contact.phone, "more-phone"), enabled: !!contact.phone },
  ];

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-30 mt-2 w-52 overflow-hidden rounded-2xl border border-[var(--border-strong)] py-1.5 shadow-[var(--shadow-lg)]"
      style={{ background: "var(--panel-solid)" }}
    >
      {items.map((i) => (
        <button
          key={i.label}
          onClick={() => {
            i.onClick();
            onClose();
          }}
          disabled={!i.enabled}
          className="block w-full px-4 py-2.5 text-left text-sm transition-colors hover:bg-[var(--raise)] disabled:opacity-40"
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

function NotePanel({ contactId, onDone }: { contactId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);

  return (
    <form
      action={async (formData: FormData) => {
        setBusy(true);
        try {
          await addNoteAction(contactId, formData);
          onDone();
        } finally {
          setBusy(false);
        }
      }}
      className="mt-6 rounded-2xl border border-[var(--border)] p-4"
    >
      <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        Add a note
      </label>
      <textarea
        name="note"
        rows={3}
        required
        autoFocus
        placeholder="What happened?"
        className="field-input resize-y"
      />
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onDone} className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-medium">
          Cancel
        </button>
        <button type="submit" disabled={busy} className="btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60">
          {busy ? "Saving…" : "Save note"}
        </button>
      </div>
    </form>
  );
}

function RevenuePanel({ summary }: { summary?: ContactSummary }) {
  if (!summary) return null;

  return (
    <div className="mt-6 rounded-2xl border border-[var(--border)] p-5">
      <h3 className="text-base font-semibold">Revenue</h3>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl px-4 py-3" style={{ background: "var(--green-soft)" }}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--green)" }}>
            Won
          </p>
          <p className="mt-0.5 text-xl font-bold" style={{ color: "var(--green)" }}>
            {money(summary.wonValue)}
          </p>
        </div>
        <div className="rounded-xl px-4 py-3" style={{ background: "var(--accent-soft)" }}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">In pipeline</p>
          <p className="mt-0.5 text-xl font-bold text-accent">{money(summary.openValue)}</p>
        </div>
      </div>

      {summary.deals.length ? (
        <div className="mt-4 space-y-2">
          {summary.deals.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] px-3.5 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{d.title}</p>
                <p className="text-xs capitalize text-faint">{d.stage.replace(/-/g, " ")}</p>
              </div>
              <span
                className="shrink-0 text-sm font-semibold"
                style={{ color: d.won ? "var(--green)" : "var(--text)" }}
              >
                {money(d.value)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        // Honest empty state rather than a zero that looks like a measurement.
        <p className="mt-4 text-sm text-faint">No deals for this contact yet.</p>
      )}
    </div>
  );
}

const KIND_META: Record<string, { icon: typeof User; color: string; soft: string }> = {
  note: { icon: StickyNote, color: "var(--purple)", soft: "var(--purple-soft)" },
  call: { icon: Phone, color: "var(--accent)", soft: "var(--accent-soft)" },
  text: { icon: MessageCircle, color: "var(--accent)", soft: "var(--accent-soft)" },
  email: { icon: Mail, color: "var(--accent)", soft: "var(--accent-soft)" },
  meeting: { icon: Calendar, color: "var(--amber)", soft: "var(--amber-soft)" },
  revenue: { icon: DollarSign, color: "var(--green)", soft: "var(--green-soft)" },
  deal: { icon: DollarSign, color: "var(--green)", soft: "var(--green-soft)" },
  created: { icon: Plus, color: "var(--text-faint)", soft: "var(--raise)" },
  updated: { icon: Pencil, color: "var(--text-faint)", soft: "var(--raise)" },
};

function ActivityPanel({
  contact,
  entries,
  currentUser,
}: {
  contact: Contact;
  entries: TimelineEntry[];
  currentUser: string | null;
}) {
  return (
    <div className="mt-7 rounded-2xl border border-[var(--border)] p-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Contact Activity</h3>
          <span className="mt-1.5 block h-0.5 w-10 rounded-full accent-gradient" />
        </div>
        <span className="text-xs text-faint">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      {entries.length === 0 ? (
        // The old panel showed three invented rows here. Nothing has happened
        // with this contact yet, and saying so is more useful than a fixture.
        <p className="mt-5 text-sm text-faint">
          Nothing logged yet. Calls, texts, emails, notes, meetings and won deals all appear here
          automatically.
        </p>
      ) : (
        <ol className="mt-5 space-y-3">
          {entries.map((e) => {
            const meta = KIND_META[e.kind] ?? KIND_META.updated;
            const Icon = meta.icon;
            return (
              <li key={e.id} className="flex items-start gap-3">
                <span
                  className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                  style={{ background: meta.soft, color: meta.color }}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <p className="text-sm font-medium">{e.title}</p>
                    {/* Real stored instants, rendered live — the old panel had
                        "23 May 2024, 9:41 AM" typed into the seed and a "Date +
                        Time" button that did nothing. */}
                    <TimeAgo at={e.at} className="shrink-0 text-[11px] text-faint" />
                  </div>
                  {e.detail && <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted">{e.detail}</p>}
                  {e.amount !== undefined && (
                    <p className="mt-0.5 text-xs font-semibold" style={{ color: "var(--green)" }}>
                      {money(e.amount)}
                    </p>
                  )}
                </div>
                {/* Only entries logged here can be removed. A meeting or a won
                    deal belongs to its own record — deleting the echo would
                    just make the history lie. */}
                {e.source === "logged" && (
                  <button
                    onClick={() => deleteActivityAction(contact.id, e.id)}
                    className="focus-ring mt-0.5 shrink-0 text-faint transition-colors hover:text-[var(--red)]"
                    aria-label="Delete entry"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {currentUser && (
        <p className="mt-5 border-t border-[var(--border)] pt-3 text-[11px] text-faint">
          Owned by {contact.owner}
        </p>
      )}
    </div>
  );
}

/* ---------------- RIGHT: contacts list ---------------- */

function ContactsList({
  contacts,
  selectedId,
  onSelect,
  onAdd,
  filter,
  setFilter,
  grouped,
  toggleGrouped,
  className,
}: {
  contacts: Contact[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  filter: "all" | ContactType;
  setFilter: (f: "all" | ContactType) => void;
  grouped: boolean;
  toggleGrouped: () => void;
  className?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const visible = useMemo(
    () => (filter === "all" ? contacts : contacts.filter((c) => c.type === filter)),
    [contacts, filter]
  );

  const groups = useMemo(() => {
    if (!grouped) return null;
    return (["client", "lead"] as ContactType[])
      .map((type) => ({ type, rows: visible.filter((c) => c.type === type) }))
      .filter((g) => g.rows.length > 0);
  }, [grouped, visible]);

  const filters: { id: "all" | ContactType; label: string }[] = [
    { id: "all", label: "All contacts" },
    { id: "client", label: "Clients only" },
    { id: "lead", label: "Leads only" },
  ];

  return (
    <aside className={clsx("card flex flex-col overflow-hidden p-5", className)}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">
          Contacts
          <span className="ml-2 text-sm font-normal text-faint">{visible.length}</span>
        </h2>
        <div className="relative flex items-center gap-2">
          {/* Was a decorative chevron. Now collapses the list into its
              categories, which is what the arrow implied all along. */}
          <button
            onClick={toggleGrouped}
            title={grouped ? "Show as one list" : "Group by type"}
            aria-pressed={grouped}
            className={clsx(
              "focus-ring grid h-9 w-9 place-items-center rounded-full transition-colors",
              grouped ? "text-accent" : "btn-soft text-muted"
            )}
            style={grouped ? { background: "var(--accent-soft)" } : undefined}
          >
            <ChevronDown className={clsx("h-4 w-4 transition-transform", grouped && "rotate-180")} />
          </button>

          <button
            onClick={() => setMenuOpen((m) => !m)}
            title="Filter by type"
            aria-expanded={menuOpen}
            className={clsx(
              "focus-ring grid h-9 w-9 place-items-center rounded-full transition-colors",
              filter !== "all" ? "text-accent" : "btn-soft text-muted"
            )}
            style={filter !== "all" ? { background: "var(--accent-soft)" } : undefined}
          >
            <Filter className="h-4 w-4" />
          </button>

          <button onClick={onAdd} className="btn-accent focus-ring grid h-9 w-9 place-items-center rounded-full" aria-label="Add contact">
            <Plus className="h-[18px] w-[18px]" />
          </button>

          {menuOpen && (
            <div
              ref={menuRef}
              className="absolute right-0 top-full z-30 mt-2 w-48 overflow-hidden rounded-2xl border border-[var(--border-strong)] py-1.5 shadow-[var(--shadow-lg)]"
              style={{ background: "var(--panel-solid)" }}
            >
              {filters.map((f) => (
                <button
                  key={f.id}
                  onClick={() => {
                    setFilter(f.id);
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors hover:bg-[var(--raise)]"
                >
                  {f.label}
                  {filter === f.id && <Check className="h-4 w-4 text-accent" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="-mx-2 -my-1 flex flex-1 scroll-p-1 flex-col gap-2 overflow-y-auto px-2 py-1">
        {visible.length === 0 && <p className="mt-6 text-center text-sm text-faint">No contacts match this filter.</p>}

        {groups
          ? groups.map((g) => (
              <div key={g.type} className="mb-1">
                <p className="mb-2 mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                  {g.type === "client" ? "Clients" : "Leads"}
                  <span className="ml-1.5 font-normal">{g.rows.length}</span>
                </p>
                <div className="flex flex-col gap-2">
                  {g.rows.map((c) => (
                    <ContactRow key={c.id} contact={c} active={c.id === selectedId} onSelect={onSelect} />
                  ))}
                </div>
              </div>
            ))
          : visible.map((c) => (
              <ContactRow key={c.id} contact={c} active={c.id === selectedId} onSelect={onSelect} />
            ))}
      </div>
    </aside>
  );
}

function ContactRow({
  contact,
  active,
  onSelect,
}: {
  contact: Contact;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const isLead = contact.type === "lead";
  return (
    <button
      onClick={() => onSelect(contact.id)}
      className={clsx(
        "focus-ring flex items-center gap-3 rounded-2xl border p-3 text-left transition-colors",
        active ? "border-[var(--border-strong)]" : "border-[var(--border)] hover:border-[var(--border-strong)]"
      )}
      style={active ? { background: "var(--accent-soft)" } : undefined}
    >
      <Avatar initials={contact.initials} color={contact.color} />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-semibold">
          {contact.firstName} {contact.lastName}
        </p>
        <p className="truncate text-xs text-faint">{contact.info}</p>
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <Overlay>
      <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        {/* Opaque, not the translucent `.card` used for page panels. Over a busy
            page the frosted panel let content show through and the form became
            hard to read. */}
        <form
          action={onSubmit}
          className="modal-surface relative z-10 w-full max-w-lg overflow-y-auto p-6"
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
