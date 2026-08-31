"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  DollarSign,
  Filter,
  Mail,
  MapPin,
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
import { useRememberedToggle } from "@/lib/remembered-toggle";
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

/**
 * Whether the three panels are stacked into one column.
 *
 * Watches the GRID'S OWN WIDTH rather than the viewport's, because that is what
 * the layout actually keys off: the breakpoints here are container queries
 * (`@min-[700px]`), and the container is the viewport minus the sidebar. A
 * viewport media query would disagree with the layout through the whole range
 * where the sidebar is present but the content is still narrow — claiming two
 * columns while the user is looking at one.
 */
function useGridWidth(ref: React.RefObject<HTMLElement | null>): number {
  /*
     Returns the width rather than one boolean, because two decisions key off
     it now: whether the panels are stacked (700) and whether Contact Activity
     folds (1030, where Status gets its own column and there is nothing to
     scroll past). One observer, two thresholds derived at the call site.

     0 until measured. Every threshold below is a `>=`, so an unmeasured grid
     behaves as the narrow case — which is the safe way round: a fold that
     appears for an instant is a smaller wrong than a desktop that renders
     collapsed.
  */
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

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
  /*
     On a phone the three panels become one column in DOM order — details,
     profile, then the list — so the index of contacts started 1,648px down a
     852px screen. The user landed on the details of somebody they had not
     chosen and had to scroll past two screens to reach the list.

     So on a stacked layout this behaves like every contacts app on a phone:
     the list IS the page, and choosing somebody opens them. Nothing about the
     side-by-side layout changes, because there the list is already in view.
  */
  const gridRef = useRef<HTMLDivElement>(null);
  const gridWidth = useGridWidth(gridRef);
  const stacked = gridWidth < 700;
  /* Below the three-column width, Status sits underneath the profile panel and
     a long history is a scroll between the reader and it. At 1030 and above
     they are side by side and the fold has nothing to earn. */
  const foldsActivity = gridWidth < 1030;
  const [showDetail, setShowDetail] = useState(false);
  const openContact = useCallback((id: string) => {
    setSelectedId(id);
    setShowDetail(true);
  }, []);
  /* Both derived, and deliberately not synced.

     The first version reset `showDetail` in an effect when the layout widened,
     which React's own lint rule flags — and it was unnecessary. Every hiding
     decision below is gated on `stacked`, so on a wide layout both of these are
     false and nothing is hidden whatever `showDetail` happens to hold. There is
     no state to correct, only state to ignore. */
  const listOnly = stacked && !showDetail;
  const detailOnly = stacked && showDetail;
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
      /* `dvh`, and a minimum rather than a fixed height. On iOS `100vh` is the
         viewport with the toolbar HIDDEN, so this box was always taller than
         the screen showing it and centred its content against a height the
         reader could not see; the same reasoning the chat panel already
         carries. A minimum also lets the message grow rather than be clipped
         if it ever wraps to more lines than the box allows. */
      <div className="grid min-h-[calc(100dvh-104px)] place-items-center">
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
      ref={gridRef}
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
      {detailOnly && (
        /* The way back, and it has to exist before the panels it returns from.
           Placed first in the column so it is the first thing under the header
           rather than something to hunt for. */
        <button
          type="button"
          onClick={() => setShowDetail(false)}
          className="btn-soft focus-ring flex items-center gap-2 self-start rounded-xl px-3 py-2 text-sm font-medium"
        >
          <ChevronLeft className="h-4 w-4" /> All contacts
        </button>
      )}
      <InfoPanel
        contact={contact}
        /*
           The card comes first in one column; these fields follow it.

           Stacked, the DOM order was fields-then-card, so opening somebody put
           a Status heading and a column of labelled rows above the thing that
           says who they are — the avatar, the name, and every action you might
           take. You had to scroll past the record to reach the person.

           `order` rather than moved markup, because from `@min-[700px]` up the
           named grid areas already place these correctly and are written
           against this source order. Both are reset there, so the two- and
           three-column layouts are untouched.
        */
        className={clsx(
          "order-2 @min-[700px]:order-none @min-[700px]:[grid-area:info]",
          listOnly && "hidden"
        )}
      />
      <ProfilePanel
        className={clsx(
          "order-1 @min-[700px]:order-none @min-[700px]:[grid-area:profile]",
          listOnly && "hidden"
        )}
        contact={contact}
        summary={summary}
        currentUserId={currentUserId}
        onEdit={() => setModal(contact)}
        onDelete={() => handleDelete(contact.id)}
        panel={panel}
        setPanel={setPanel}
        busy={busy}
        foldsActivity={foldsActivity}
      />
      <ContactsList
        className={clsx("@min-[700px]:[grid-area:list]", detailOnly && "hidden")}
        contacts={contacts}
        selectedId={contact.id}
        onSelect={openContact}
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
  className,
}: {
  contact: Contact;
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

      {/*
          The Won/Open pair used to sit here, and it was the same two figures the
          Revenue panel opens with — one tap away on the card, with the deals
          that make them up underneath. Asked whether it was needed here at all;
          it is not. Two places showing one number is how they drift, and this
          panel is the record, not the reporting.
      */}

      <Section title="Personal Information">
        {/* Whole name first: it is what you came to check, and the parts are the
            detail under it rather than the other way round. */}
        <InfoRow
          icon={UserRound}
          label={contact.type === "lead" ? "Lead Name" : "Client Name"}
          value={`${contact.firstName} ${contact.lastName}`}
        />
        <InfoRow icon={User} label="First Name" value={contact.firstName} />
        <InfoRow icon={UserRound} label="Last Name" value={contact.lastName} />
      </Section>

      <Section title="Company">
        <InfoRow icon={Building2} label="Company" value={contact.company} />
        {/*
            The real `location` column, not `companyInfo`.

            This row used to read `companyInfo`, and `companyInfo` and `company`
            both derive from the same `info` column — so the panel printed the
            company name twice and labelled the second one "Company Info". Once
            it was relabelled "Location" that became actively wrong: it showed
            "Location: Dube Landscaping".

            There was never anything to clean up. `contacts.location` exists,
            is populated for every record, and holds exactly what it should —
            Cape Town, Johannesburg, Durban, Pretoria. Nothing was reading it.
        */}
        <InfoRow icon={MapPin} label="Location" value={contact.location} />
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
  summary,
  currentUserId,
  onEdit,
  onDelete,
  panel,
  setPanel,
  busy,
  className,
  foldsActivity,
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
  /** Whether Contact Activity can fold — see `useGridWidth`. */
  foldsActivity: boolean;
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
      {/*
          Three across until there is genuinely room for six.

          Six columns needed 66px a cell at the 440px cap and got 48 on a phone
          — exactly the width of the circle itself, leaving nothing for the
          label under it. "Revenue" and "Email" then ran into their neighbours,
          which is the overlapping row in the report.

          Two rows of three is the honest shape at that width: every button gets
          about 104px, the labels sit clear of each other, and the spacing is
          even because the grid makes it so. Six returns at `@min-[1030px]`,
          which is where the middle column is guaranteed 380px — the width the
          surrounding grid already treats as the floor for this row.

          `gap-y` is larger than `gap-x` while wrapped, so the two rows read as
          two rows rather than a block of icons.
      */}
      <div className="relative mx-auto mt-6 grid w-full max-w-[440px] grid-cols-3 gap-x-2 gap-y-4 @min-[1030px]:grid-cols-6 @min-[1030px]:gap-y-2">
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

      <ActivityPanel foldsActivity={foldsActivity} contact={contact} entries={summary?.timeline ?? []} currentUserId={currentUserId} />
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
  foldsActivity,
}: {
  contact: Contact;
  entries: TimelineEntry[];
  currentUserId: string | null;
  /** Whether the fold applies at the current width — see `useGridWidth`. */
  foldsActivity: boolean;
}) {
  /* The last thing that happened, which is the fact a contact panel is usually
     opened to find. Derived from the entries already loaded — the list is
     sorted newest first upstream — so it cannot disagree with the rows below. */
  const latest = entries[0];

  /*
     Folded away by default, and it remembers.

     A contact with a long history put its whole timeline between the reader and
     the Status panel underneath it, so reaching Status meant scrolling past
     everything that had ever happened. Closed by default because the summary
     line above already answers the common question — when this person was last
     touched — and the detail is one tap away for the times it is not enough.

     Same memory the dashboard folds use, under this page's own key: somebody
     who wants the history open on every contact should not have to say so on
     every contact.
  */
  const [open, toggle] = useRememberedToggle("contact-open:activity", false);
  const headerRef = useRef<HTMLButtonElement>(null);

  /*
     Closing from the bottom puts focus back on the header.

     The button that did it is the first thing to disappear, and a control that
     vanishes under the pointer drops keyboard focus to the body — the reader
     loses their place in the page entirely. Handing focus to the header leaves
     them on the thing they just collapsed, which is both where they now are on
     screen and the control that would open it again.
  */
  const collapse = useCallback(() => {
    toggle();
    headerRef.current?.focus();
  }, [toggle]);

  return (
    <div className="mt-7 rounded-2xl border border-[var(--border)] p-5">
      {/*
          Built to read like the Revenue fold on Home — a titled header with a
          real summary line under it, then a bordered inner surface with column
          headings and right-aligned values, so a list of things becomes a
          ledger you can scan.

          The structure is borrowed; the palette is not. Home's fold is green
          throughout because it is about money. This panel carries several kinds
          of event, so it keeps the contacts page's own per-kind colours —
          purple for notes, accent for calls and mail, amber for meetings, green
          only where there is actually money — and the inner surface is
          `--raise` rather than a green wash.
      */}
      <button
        ref={headerRef}
        type="button"
        onClick={toggle}
        disabled={!foldsActivity}
        /* Honest, and it has to be. Driven from CSS alone this said
           `aria-expanded="false"` on a desktop where the content was plainly
           visible — announcing collapsed to a screen reader while sighted users
           read the list. `foldsActivity` comes from the same observer the
           layout uses, so the markup and the pixels cannot disagree. */
        aria-expanded={foldsActivity ? open : undefined}
        aria-controls="contact-activity"
        /*
           The whole header is the control, so there is no small chevron to aim
           at — the same shape the dashboard's folds use.

           `@min-[1030px]` is where the fold stops existing, and it is the width
           the surrounding grid gives Status its own column. Below that, Status
           sits underneath this panel and a long history is a scroll between the
           reader and it; at that width and above they are side by side and
           there is nothing to scroll past. The dashboard's own folds key off
           `sm` because its layout does; this one follows this page's layout.

           `cursor-default` above the breakpoint because it is inert there — a
           pointer on something that does not respond is a small lie.
        */
        className="focus-ring flex w-full items-start justify-between gap-3 rounded-lg text-left disabled:cursor-default"
      >
        <div className="min-w-0">
          <h3 className="text-base font-semibold">Contact Activity</h3>
          {/* The Revenue fold states its scope under its title ("$314,400 won ·
              last 6 weeks"). The equivalent fact here is when this person was
              last touched, which is the question the panel exists to answer. */}
          {latest ? (
            <p className="mt-1 text-xs text-muted">
              {/* `relative` here, `both` in the rows. This line is a summary and
                  wants to read like the Revenue fold's "last 6 weeks"; the exact
                  stamp belongs in the ledger below, where it is the record. */}
              Last activity <TimeAgo at={latest.at} mode="relative" className="text-muted" />
            </p>
          ) : (
            <p className="mt-1 text-xs text-faint">Nothing logged yet</p>
          )}
          <span className="mt-2 block h-0.5 w-10 rounded-full accent-gradient" />
        </div>
        <span className="flex shrink-0 items-center gap-2 pt-0.5 text-xs text-faint">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
          {/* Hidden where the fold does not exist, so the desktop panel does not
              carry a chevron that means nothing. */}
          {foldsActivity && (
            <ChevronDown
              className={clsx("h-4 w-4 transition-transform", open && "rotate-180")}
              aria-hidden
            />
          )}
        </span>
      </button>

      {/* The state is only consulted where the fold exists. Above it the panel
          renders as it always did, whatever the remembered preference says. */}
      <div id="contact-activity" className={clsx(foldsActivity && !open && "hidden")}>
      {entries.length === 0 ? (
        // The old panel showed three invented rows here. Nothing has happened
        // with this contact yet, and saying so is more useful than a fixture.
        <p className="mt-5 text-sm text-faint">
          Nothing logged yet. Calls, texts, emails, notes, meetings and won deals all appear here
          automatically.
        </p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
          {/* Column headings, as the Revenue table has. They are what turn a
              stack of rows into something with an axis to read along. */}
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-3.5 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">Activity</span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">When</span>
          </div>
          <ol className="divide-y divide-[var(--border)]">
          {entries.map((e) => {
            const meta = KIND_META[e.kind] ?? KIND_META.updated;
            const Icon = meta.icon;
            return (
              <li key={e.id} className="flex items-start gap-3 px-3.5 py-3">
                <span
                  className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                  style={{ background: meta.soft, color: meta.color }}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{e.title}</p>
                  {e.detail && <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted">{e.detail}</p>}
                  {e.amountCents !== undefined && (
                    /* Money reads as a figure rather than a caption — the one
                       thing worth copying straight from the Revenue table. */
                    <p className="mt-1 text-sm font-bold tabular-nums" style={{ color: "var(--green)" }}>
                      {money(e.amountCents)}
                    </p>
                  )}
                </div>
                {/* The right-hand column, filled on every row. The Revenue table
                    puts its amount here; on a timeline the value you scan down
                    is the time, and amounts belong beside the thing they are
                    the value of.

                    Real stored instants, rendered live — the panel this
                    replaces had "23 May 2024, 9:41 AM" typed into the seed and
                    a "Date + Time" button that did nothing. */}
                <TimeAgo at={e.at} className="shrink-0 pt-0.5 text-[11px] text-faint" />
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
        </div>
      )}

      {/*
          A way out at the end of the list.

          Reported as extra work, and it is: opening the fold puts the control
          that closes it at the top of everything it just revealed, so on a long
          history you scroll back past the whole thing to put it away. A reader
          who has reached the end of the list has finished with it — that is
          exactly where the offer to close it belongs.

          Only where the fold exists, only while it is open, and only when there
          is a list to have reached the end of: under the empty state the header
          is already in view and a second control would be noise.
      */}
      {foldsActivity && open && entries.length > 0 && (
        <button
          type="button"
          onClick={collapse}
          className="btn-soft focus-ring mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-medium text-muted"
        >
          <ChevronUp className="h-3.5 w-3.5" />
          Hide activity
        </button>
      )}

      {currentUserId && (
        <p className="mt-5 border-t border-[var(--border)] pt-3 text-[11px] text-faint">
          Owned by {contact.owner}
        </p>
      )}
      </div>
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
      {/*
          The heading gets its own line, because the row was never wide enough
          for both.

          Holding the two apart stopped them colliding and moved the cost onto
          the title: five 36px controls plus their gaps need 212px, and this
          column is a fixed 326 on a desktop and narrower on a phone. So
          "Contacts 15" truncated to "Conta…" — at every width, not just the
          small ones. No single row fits both, and a heading that cannot be read
          is a worse trade than one more line.

          The title is now stated in full above, and the controls keep the exact
          spacing they already had. Nothing truncates and nothing overlaps at
          any width.
      */}
      <div className="mb-4">
        {/* Title left, count right — the arrangement the Contact Activity panel
            already uses for its own heading and entry count, so the two titled
            blocks on this page read as one family. It also puts something at
            each end of the line rather than leaving the right half empty. */}
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Contacts</h2>
          <span className="text-sm text-faint tabular-nums">{visible.length}</span>
        </div>
        {/* The accent rule this app puts under a section title. Its absence is
            part of why the heading read as a loose label rather than the head
            of a panel. */}
        <span className="mt-2 block h-0.5 w-10 rounded-full accent-gradient" />
        {/*
            Spread across the row rather than huddled at one end.

            Right-aligning them left the entire left half of the row empty, so a
            balanced heading sat above an unbalanced strip — which is what read
            as unfinished. `justify-between` uses the width the row already
            occupies and puts an equal gap between every pair: five 36px
            controls in a 326px column leave 146px, or 36 between each.

            Evenly spaced in the literal sense, and the two ends now line up
            with the heading and the count above them.
        */}
        <div className="relative mt-3 flex items-center justify-between gap-2">
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
          /* The cap lives in `.modal-surface` now. It was an inline style here,
             which beats the stylesheet, so this one form would have quietly
             kept `90vh` — the wrong unit on iOS — while every other modal in
             the app was fixed. */
          className="modal-surface relative z-10 w-full max-w-lg p-6"
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
            {/*
                A real Location field, and it closes a data-loss bug.

                `parseContact` has always read `formData.get("location")`, and
                this form has never had a `location` input — so every save sent
                `text(null)`, which is `""`, which is not `undefined`, so the
                repo's `CASE WHEN ... THEN location` branch fired and wrote it
                away. Proven against the dev database inside a rolled-back
                transaction: a contact with "Cape Town" came back null after one
                edit.

                Editing somebody to fix a typo in their phone number silently
                erased where they were. Now the field exists, so the form sends
                back what is there.
            */}
            <ModalField name="location" label="Location" className="sm:col-span-2" defaultValue={contact?.location} />
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
        <div className="modal-surface relative z-10 w-full max-w-lg p-6">
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
