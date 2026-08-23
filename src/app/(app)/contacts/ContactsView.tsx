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
  Upload,
  User,
  UserRound,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Overlay } from "@/components/ui/Overlay";
import { SortMenu } from "@/components/ui/SortMenu";
import { TimeAgo } from "@/components/ui/TimeAgo";

/**
 * A contact, decorated with what the screen needs and the record no longer stores.
 *
 * `type`, `status`, `initials` and `color` were columns once. Three of them were
 * presentation and the fourth — a stored sales position — was the thing that
 * went stale and disagreed with the deals underneath it. They are derived here,
 * at the edge, where being wrong is a redraw rather than a wrong number in a
 * database.
 */
import type { ContactSummary, TimelineEntry } from "@/server/contact-summaries";
import type { Contact, ContactType } from "@/server/decorate-contact";
export type { Contact, ContactType } from "@/server/decorate-contact";
import { clsx } from "@/lib/clsx";
import type { ImportPreview, ImportResult } from "@/server/import-contacts";
import {
  addContactAction,
  bulkAssignContactsAction,
  bulkDeleteContactsAction,
  bulkSetCompanyAction,
  importContactsAction,
  previewImportAction,
  addNoteAction,
  deleteContactAction,
  logOutreachAction,
  updateContactAction,
} from "./actions";

/** null = closed, "new" = add mode, Contact = edit mode */
type ModalState = null | "new" | "import" | Contact;
type Panel = null | "note" | "revenue";

/** Takes integer cents, because that is what the database stores. */
const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;

export function ContactsView({
  contacts,
  summaries,
  currentUserId,
  people = [],
  companies = [],
}: {
  contacts: Contact[];
  /** Colleagues who can own a record, for the assign control. */
  people?: { id: string; name: string }[];
  companies?: { id: string; name: string }[];
  summaries: Record<string, ContactSummary>;
  currentUserId: string | null;
}) {
  const [selectedId, setSelectedId] = useState(contacts[0]?.id ?? "");
  const [modal, setModal] = useState<ModalState>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | ContactType>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  /**
   * Won value per contact, for the "most valuable" order.
   *
   * Read from the summaries the page already loads rather than fetched again —
   * the figure on the card and the figure the sort uses have to be the same
   * number, or the order looks wrong to the person reading it.
   */
  const values = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [id, s] of Object.entries(summaries)) out[id] = s.wonValueCents;
    return out;
  }, [summaries]);
  const [grouped, setGrouped] = useState(false);

  const contact = contacts.find((c) => c.id === selectedId) ?? contacts[0];
  const summary = contact ? summaries[contact.id] : undefined;

  async function handleSubmit(formData: FormData) {
    setBusy(true);
    try {
      if (modal === "new") {
        const newId = await addContactAction(formData);
        if (newId) setSelectedId(newId);
      } else if (modal && modal !== "import") {
        await updateContactAction(modal.id, formData);
      }
      setModal(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    // Says where it goes, not just that it goes. The delete has always been
    // soft, but this line read as though it were final — so the honest response
    // to a mis-click was to assume the record was lost rather than to look for
    // it. Settings is where it now waits.
    if (
      !confirm(
        "Delete this contact? They come off every list, and their activity goes with them. " +
          "You can put them back from Settings → Recently deleted."
      )
    )
      return;
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
    modal === "import" ? (
      <ImportModal onClose={() => setModal(null)} />
    ) : modal !== null ? (
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
          {/* Import sits beside "add one" on the empty screen, because an
              agency arriving with an existing book of business is not going to
              type five hundred people in one at a time — and if they cannot
              find the import they do not report it, they leave. */}
          <div className="mt-4 flex items-center justify-center gap-2">
            <button onClick={() => setModal("new")} className="btn-accent rounded-xl px-5 py-2.5 text-sm font-semibold">
              Add your first contact
            </button>
            <button onClick={() => setModal("import")} className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium">
              <Upload className="h-4 w-4" /> Import a CSV
            </button>
          </div>
        </div>
        {modalEl}
      {bulkOpen && (
        <BulkActions
          count={selected.size}
          people={people}
          companies={companies}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setSelected(new Set());
            setBulkOpen(false);
          }}
          ids={[...selected]}
        />
      )}

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
        currentUserId={currentUserId}
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
        onImport={() => setModal("import")}
        filter={filter}
        setFilter={setFilter}
        grouped={grouped}
        toggleGrouped={() => setGrouped((g) => !g)}
        values={values}
        selected={selected}
        setSelected={setSelected}
        onBulk={() => setBulkOpen(true)}
      />
      {modalEl}
      {bulkOpen && (
        <BulkActions
          count={selected.size}
          people={people}
          companies={companies}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setSelected(new Set());
            setBulkOpen(false);
          }}
          ids={[...selected]}
        />
      )}

    </div>
  );
}

/* ---------------- LEFT: info panel ---------------- */



function InfoPanel({
  contact,
  summary,
  className,
}: {
  contact: Contact;
  summary?: ContactSummary;
  className?: string;
}) {
  // Derived status, so the palette is chosen from what is true now.
  const tone = contact.isClient
    ? { color: "var(--green)", soft: "var(--green-soft)" }
    : contact.hasOpenDeal
      ? { color: "var(--accent)", soft: "var(--accent-soft)" }
      : { color: "var(--muted)", soft: "var(--rule-soft)" };

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
          <MiniStat label="Won" value={money(summary.wonValueCents)} tone="var(--green)" />
          <MiniStat label="Open" value={money(summary.openValueCents)} tone="var(--accent)" />
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
  currentUserId,
  onEdit,
  onDelete,
  panel,
  setPanel,
  busy,
  className,
}: {
  contact: Contact;
  summary?: ContactSummary;
  currentUserId: string | null;
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

      <ActivityPanel contact={contact} entries={summary?.timeline ?? []} currentUserId={currentUserId} />
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
            {money(summary.wonValueCents)}
          </p>
        </div>
        <div className="rounded-xl px-4 py-3" style={{ background: "var(--accent-soft)" }}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">In pipeline</p>
          <p className="mt-0.5 text-xl font-bold text-accent">{money(summary.openValueCents)}</p>
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
                {money(d.valueCents)}
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
  currentUserId,
}: {
  contact: Contact;
  entries: TimelineEntry[];
  currentUserId: string | null;
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
                  {e.amountCents !== undefined && (
                    <p className="mt-0.5 text-xs font-semibold" style={{ color: "var(--green)" }}>
                      {money(e.amountCents)}
                    </p>
                  )}
                </div>
                {/* Entries used to be removable, and are not any more.

                    The reasoning that already applied to meetings and won deals
                    — "deleting the echo would just make the history lie" — turns
                    out to apply to every entry. A timeline someone can edit is
                    not a record of what happened, it is a record of what they
                    were willing to leave visible. The log is append-only now,
                    so there is nothing here to press.

                    A mistyped note stays, and a correcting note goes underneath
                    it. That is how a ledger works, and this is a ledger. */}
              </li>
            );
          })}
        </ol>
      )}

      {currentUserId && (
        <p className="mt-5 border-t border-[var(--border)] pt-3 text-[11px] text-faint">
          Owned by {contact.owner}
        </p>
      )}
    </div>
  );
}

/* ---------------- RIGHT: contacts list ---------------- */

/**
 * How the list can be ordered.
 *
 * There were no sort controls on any of twelve screens. Invisible at ten
 * records and unusable at five hundred — which is exactly what a CSV import
 * now produces on day one, so the two arrived together.
 *
 * "Recently added" is the default rather than alphabetical: after an import or
 * a call, the person you want is the one you just created, and finding them
 * alphabetically means knowing their surname.
 */
const SORTS = [
  { id: "recent", label: "Recently added" },
  { id: "name", label: "Name (A–Z)" },
  { id: "company", label: "Company" },
  { id: "value", label: "Most valuable" },
] as const;
type SortId = (typeof SORTS)[number]["id"];

function sortContacts(rows: Contact[], sort: SortId, values: Record<string, number>): Contact[] {
  const byName = (a: Contact, b: Contact) =>
    `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`);

  // Copied before sorting: `sort` mutates, and the array is React state
  // rendered elsewhere on the page.
  const out = [...rows];
  switch (sort) {
    case "name":
      return out.sort(byName);
    case "company":
      // Contacts with no company sink rather than sorting under "" at the top,
      // where they push everything else out of view.
      return out.sort((a, b) => {
        const ac = a.companyName ?? a.info ?? "";
        const bc = b.companyName ?? b.info ?? "";
        if (!ac && !bc) return byName(a, b);
        if (!ac) return 1;
        if (!bc) return -1;
        return ac.localeCompare(bc) || byName(a, b);
      });
    case "value":
      return out.sort((a, b) => (values[b.id] ?? 0) - (values[a.id] ?? 0) || byName(a, b));
    case "recent":
    default:
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

function ContactsList({
  contacts,
  selectedId,
  onSelect,
  onAdd,
  onImport,
  filter,
  setFilter,
  grouped,
  toggleGrouped,
  className,
  values,
  selected,
  setSelected,
  onBulk,
}: {
  contacts: Contact[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onImport: () => void;
  filter: "all" | ContactType;
  setFilter: (f: "all" | ContactType) => void;
  grouped: boolean;
  toggleGrouped: () => void;
  className?: string;
  /** Won value per contact, for the "most valuable" order. */
  values: Record<string, number>;
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  onBulk: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [sort, setSort] = useState<SortId>("recent");
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

  const visible = useMemo(() => {
    const filtered = filter === "all" ? contacts : contacts.filter((c) => c.type === filter);
    return sortContacts(filtered, sort, values);
  }, [contacts, filter, sort, values]);

  const allShown = visible.length > 0 && visible.every((c) => selected.has(c.id));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

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

          <SortMenu options={SORTS} value={sort} onChange={setSort} defaultId="recent" />

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

          {/* Import lives beside Add, not only on the empty screen. An agency
              with fifty contacts still has four hundred and fifty in a
              spreadsheet, and an import they cannot find is one they do not
              believe exists. */}
          <button
            onClick={onImport}
            className="btn-soft focus-ring grid h-9 w-9 place-items-center rounded-full"
            aria-label="Import contacts from a CSV"
            title="Import from CSV"
          >
            <Upload className="h-4 w-4" />
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

      {/**
        * The selection bar, shown only once something is selected.
        *
        * Always-visible checkboxes on a list you mostly click through are
        * clutter; a bar that appears when it is relevant is not. Selecting is
        * done by the checkbox that appears on hover or focus, so a keyboard
        * user can reach it.
        */}
      {selected.size > 0 && (
        <div
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl px-3.5 py-2.5"
          style={{ background: "var(--accent-soft)" }}
        >
          <span className="text-sm font-medium text-accent">
            {selected.size} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelected(allShown ? new Set() : new Set(visible.map((c) => c.id)))}
              className="focus-ring rounded-lg px-2.5 py-1 text-xs font-medium text-accent"
            >
              {allShown ? "Clear" : `Select all ${visible.length}`}
            </button>
            <button
              onClick={onBulk}
              className="btn-accent focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold"
            >
              Actions
            </button>
          </div>
        </div>
      )}

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
                    <ContactRow
                      key={c.id}
                      contact={c}
                      active={c.id === selectedId}
                      onSelect={onSelect}
                      checked={selected.has(c.id)}
                      onToggle={() => toggle(c.id)}
                    />
                  ))}
                </div>
              </div>
            ))
          : visible.map((c) => (
              <ContactRow
                key={c.id}
                contact={c}
                active={c.id === selectedId}
                onSelect={onSelect}
                checked={selected.has(c.id)}
                onToggle={() => toggle(c.id)}
              />
            ))}
      </div>
    </aside>
  );
}

function ContactRow({
  contact,
  active,
  onSelect,
  checked,
  onToggle,
}: {
  contact: Contact;
  active: boolean;
  onSelect: (id: string) => void;
  checked: boolean;
  onToggle: () => void;
}) {
  const isLead = contact.type === "lead";
  return (
    /**
     * A div, not a button.
     *
     * The row used to be one button, and a checkbox inside a button is invalid
     * HTML that browsers resolve by dropping the inner control — the box would
     * render and refuse to be clicked. The row keeps its keyboard behaviour
     * through role and key handling instead.
     */
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(contact.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(contact.id);
        }
      }}
      className={clsx(
        "group focus-ring flex cursor-pointer items-center gap-3 rounded-2xl border p-3 text-left transition-colors",
        active ? "border-[var(--border-strong)]" : "border-[var(--border)] hover:border-[var(--border-strong)]"
      )}
      style={active ? { background: "var(--accent-soft)" } : undefined}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Select ${contact.firstName} ${contact.lastName}`}
        className={clsx(
          "h-4 w-4 shrink-0 cursor-pointer accent-[var(--accent)] transition-opacity",
          // Revealed on hover OR focus OR when already checked. Focus matters:
          // hover-only leaves a keyboard user tabbing onto an invisible control.
          checked ? "opacity-100" : "opacity-0 focus:opacity-100 group-hover:opacity-100"
        )}
      />
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
    </div>
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

/**
 * Bringing an existing book of business in.
 *
 * Preview, then import — never straight to writing. A mapping that put phone
 * numbers in the email column is obvious on a few sample rows and invisible in
 * a summary, and by the time anybody notices, the contacts are already in.
 *
 * The file is read in the browser rather than posted as multipart. It is text,
 * it is small, and reading it here means the person sees "no rows found" before
 * a request is made rather than after one.
 */
function ImportModal({ onClose }: { onClose: () => void }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(file: File) {
    setError(null);
    setResult(null);
    setFileName(file.name);
    const text = await file.text();
    setCsv(text);

    setBusy(true);
    const fd = new FormData();
    fd.set("csv", text);
    const res = await previewImportAction(fd);
    setBusy(false);

    if ("error" in res && res.error) {
      setError(res.error);
      setPreview(null);
    } else if (res.ok) {
      setPreview(res.preview);
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("csv", csv);
    const res = await importContactsAction(fd);
    setBusy(false);

    if ("error" in res && res.error) setError(res.error);
    else if ("imported" in res) {
      setResult(res);
      setPreview(null);
    }
  }

  const willImport = preview ? preview.total - preview.duplicates : 0;

  return (
    <Overlay>
      <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="modal-surface relative z-10 max-h-[85vh] w-full max-w-lg overflow-y-auto p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Import contacts</h2>
              <p className="mt-0.5 text-xs text-faint">
                A CSV exported from your current system. The columns are matched
                by their headings.
              </p>
            </div>
            <button type="button" onClick={onClose} className="shrink-0 text-faint hover:text-[var(--text)]" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          {!result && (
            <label className="block cursor-pointer rounded-xl border border-dashed border-[var(--border)] p-6 text-center transition-colors hover:border-[var(--accent)]">
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
              />
              <Upload className="mx-auto h-5 w-5 text-faint" />
              <p className="mt-2 text-sm font-medium">
                {fileName || "Choose a CSV file"}
              </p>
              <p className="mt-0.5 text-xs text-faint">Nothing is saved until you confirm.</p>
            </label>
          )}

          {error && (
            <p className="mt-3 rounded-xl px-3.5 py-2.5 text-sm" style={{ background: "var(--red-soft)", color: "var(--red)" }}>
              {error}
            </p>
          )}

          {preview && (
            <div className="mt-4">
              <p className="text-sm">
                <strong>{preview.total}</strong> {preview.total === 1 ? "row" : "rows"} found
                {preview.duplicates > 0 && (
                  <>
                    {" · "}
                    <span style={{ color: "var(--amber)" }}>
                      {preview.duplicates} already on file
                    </span>
                  </>
                )}
              </p>

              {/* Named columns, so a wrong guess is visible before it is
                  applied rather than after. */}
              <p className="mt-1 text-xs text-faint">
                Reading:{" "}
                {Object.keys(preview.mapping).length === 0
                  ? "no columns recognised"
                  : (Object.keys(preview.mapping) as (keyof typeof preview.mapping)[])
                      .map((f) => `${f} ← "${preview.headers[preview.mapping[f]!]}"`)
                      .join(", ")}
              </p>

              {preview.sample.length > 0 && (
                <div className="mt-3 overflow-x-auto rounded-xl border border-[var(--border)]">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-faint">
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">Email</th>
                        <th className="px-3 py-2 font-medium">Phone</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample.map((r) => (
                        <tr key={r.line} className="border-b border-[var(--border)] last:border-0">
                          <td className="px-3 py-2">{`${r.firstName} ${r.lastName}`.trim()}</td>
                          <td className="px-3 py-2 text-muted">{r.email ?? "—"}</td>
                          <td className="px-3 py-2 text-muted">{r.phone ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {preview.issues.length > 0 && (
                /* Every refused row, with its line number. "412 imported" out
                   of 500 with no account of the rest looks like success. */
                <div className="mt-3 rounded-xl px-3.5 py-2.5 text-xs" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
                  <p className="font-semibold">
                    {preview.issues.length} {preview.issues.length === 1 ? "row" : "rows"} cannot be imported
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {preview.issues.slice(0, 5).map((i) => (
                      <li key={i.line}>Line {i.line}: {i.reason}</li>
                    ))}
                    {preview.issues.length > 5 && <li>…and {preview.issues.length - 5} more</li>}
                  </ul>
                </div>
              )}

              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={onClose} className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-medium">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void commit()}
                  disabled={busy || willImport === 0}
                  className="btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60"
                >
                  {busy
                    ? "Importing…"
                    : willImport === 0
                      ? "Nothing new to import"
                      : `Import ${willImport} ${willImport === 1 ? "contact" : "contacts"}`}
                </button>
              </div>
            </div>
          )}

          {result && (
            <div className="mt-2">
              <p className="rounded-xl px-3.5 py-2.5 text-sm" style={{ background: "var(--green-soft)", color: "var(--green)" }}>
                {result.imported} imported
                {result.skipped > 0 && `, ${result.skipped} already on file`}
                {result.issues.length > 0 && `, ${result.issues.length} refused`}.
              </p>
              <div className="mt-4 flex justify-end">
                <button type="button" onClick={onClose} className="btn-accent focus-ring rounded-xl px-4 py-2 text-sm font-semibold">
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/**
 * What can be done to a selection.
 *
 * Assign, move to a company, delete. Three because those are the three
 * one-at-a-time operations somebody would otherwise repeat five hundred times
 * after an import — the point at which a CRM stops being usable.
 *
 * Every action reports how many rows it ACTUALLY changed, not how many were
 * selected. An id that no longer exists, or belongs to another workspace,
 * matches nothing — and "12 updated" when 9 changed is the sort of confident
 * wrong number that stops anybody checking.
 */
function BulkActions({
  ids,
  count,
  people,
  companies,
  onClose,
  onDone,
}: {
  ids: string[];
  count: number;
  people: { id: string; name: string }[];
  companies: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function run(fn: () => Promise<{ error?: string; changed?: number }>) {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (result.error) setError(result.error);
    else onDone();
  }

  return (
    <Overlay>
      <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="modal-surface relative z-10 w-full max-w-sm p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight">
              {count} {count === 1 ? "contact" : "contacts"}
            </h2>
            <button type="button" onClick={onClose} className="shrink-0 text-faint hover:text-[var(--text)]" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          {error && (
            <p className="mb-3 rounded-xl px-3.5 py-2.5 text-sm" style={{ background: "var(--red-soft)", color: "var(--red)" }}>
              {error}
            </p>
          )}

          {confirmDelete ? (
            <div>
              {/* Soft, and it says so. Somebody who has just selected all five
                  hundred needs to know this is recoverable before they press
                  it, not after. */}
              <p className="text-sm text-muted">
                {count === 1 ? "This contact" : `These ${count} contacts`} will be removed from
                the list. Their deals and history stay, and they can be restored.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmDelete(false)} className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-medium">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => bulkDeleteContactsAction(ids))}
                  className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-semibold text-red disabled:opacity-60"
                >
                  {busy ? "Removing…" : "Remove"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Assign to</span>
                <select
                  defaultValue=""
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v !== "") void run(() => bulkAssignContactsAction(ids, v === "none" ? null : v));
                  }}
                  className="field-input"
                >
                  <option value="" disabled>
                    Choose somebody
                  </option>
                  <option value="none">Nobody (unassign)</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted">Move to company</span>
                <select
                  defaultValue=""
                  disabled={busy || companies.length === 0}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v !== "") void run(() => bulkSetCompanyAction(ids, v === "none" ? null : v));
                  }}
                  className="field-input"
                >
                  <option value="" disabled>
                    {companies.length === 0 ? "No companies yet" : "Choose a company"}
                  </option>
                  <option value="none">None</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="btn-soft focus-ring rounded-xl px-4 py-2.5 text-sm font-semibold text-red"
              >
                Remove {count === 1 ? "contact" : "contacts"}
              </button>
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}
