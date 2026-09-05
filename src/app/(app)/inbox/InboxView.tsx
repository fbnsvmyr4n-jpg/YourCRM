"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  CalendarCheck,
  Briefcase,
  ClipboardList,
  ChevronLeft,
  CornerUpLeft,
  Filter,
  CornerUpRight,
  DollarSign,
  ExternalLink,
  FileText,
  Mail,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Phone,
  Plus,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  StickyNote,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { MessageChannelBadge } from "@/components/ui/MessageChannelBadge";
import { ClientClock } from "@/components/ui/ClientClock";
import { PersonField, addressablePeople, type Person } from "@/components/ui/PersonField";
import { TimeAgo } from "@/components/ui/TimeAgo";
import {
  inboxFilters,
  MSG_CATEGORIES,
  type Attachment,
  type InboxFilter,
  type Message,
  type MsgCategory,
} from "@/data/inbox";
import { addNoteAction } from "@/app/(app)/contacts/actions";
import { clsx } from "@/lib/clsx";
import { useElementWidth } from "@/lib/use-element-width";
import { AnchoredMenu } from "@/components/ui/AnchoredMenu";
import { Overlay } from "@/components/ui/Overlay";
import { SortMenu } from "@/components/ui/SortMenu";
import { useOpenFromQuery } from "@/lib/useOpenFromQuery";
import type { ProjectOption } from "@/server/repos/inbox";
import { useDraft, hasContent, type Draft } from "@/lib/use-draft";
import { SwipeToDelete } from "@/components/ui/SwipeToDelete";
import {
  addMessageAction,
  forwardAction,
  markReadAction,
  fileThreadAction,
  replyAction,
  restoreMessageAction,
  trashMessageAction,
} from "./actions";

const CHIP_META: Record<MsgCategory, { icon: typeof Mail; tone: string; soft: string }> = {
  Appointments: { icon: CalendarCheck, tone: "var(--accent)", soft: "var(--accent-soft)" },
  Tasks: { icon: ClipboardList, tone: "var(--amber)", soft: "var(--amber-soft)" },
  "Meeting Requests": { icon: Users, tone: "var(--green)", soft: "var(--green-soft)" },
  "Follow-ups": { icon: CornerUpLeft, tone: "var(--red)", soft: "var(--red-soft)" },
  Enquiries: { icon: MessageCircle, tone: "var(--purple)", soft: "var(--purple-soft)" },
};

const INBOX_SORTS = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "unread", label: "Unread first" },
  { id: "sender", label: "Sender (A–Z)" },
] as const;
type InboxSort = (typeof INBOX_SORTS)[number]["id"];

/* Whole figures, because a contact card has room for them and an abbreviated
   "$4.5K" beside "Won" invites the reader to wonder what got rounded away. */
function money(n: number) {
  return `$${n.toLocaleString()}`;
}

function sortMessages(rows: Message[], sort: InboxSort): Message[] {
  // Copied before sorting: `sort` mutates, and this array comes from props.
  const out = [...rows];
  switch (sort) {
    case "oldest":
      return out.sort((a, b) => a.at.localeCompare(b.at));
    case "unread":
      // Unread first, still newest-first inside each group — otherwise the
      // read half arrives in an order nobody chose.
      return out.sort(
        (a, b) => Number(b.unread) - Number(a.unread) || b.at.localeCompare(a.at)
      );
    case "sender":
      return out.sort((a, b) => a.name.localeCompare(b.name) || b.at.localeCompare(a.at));
    case "newest":
    default:
      return out.sort((a, b) => b.at.localeCompare(a.at));
  }
}

/**
 * Where an unsent message is kept.
 *
 * One draft, because the composer is one box — a second New Email opens the
 * same unfinished mail rather than silently replacing it.
 */
const DRAFT_KEY = "yourcrm:inbox:draft";

export type ContactRevenue = { won: number; open: number; deals: number };

export function InboxView({
  messages,
  contactFor,
  people,
  recent,
  revenueFor,
  projects,
  companyFor,
}: {
  messages: Message[];
  contactFor: Record<string, string>;
  /** What each sender is worth, keyed by contact id — for the Revenue action. */
  revenueFor: Record<string, ContactRevenue>;
  /** Contacts and leads, so addressing a new email is recognition, not recall. */
  people: Person[];
  /** Most recently corresponded with, newest first — offered before typing. */
  recent: Person[];
  /** Live projects a conversation can be filed against. */
  projects: ProjectOption[];
  /** Contact id → company id, for marking the sender's own jobs. */
  companyFor: Record<string, string>;
}) {
  /**
   * A message in progress survives the composer closing.
   *
   * Held here rather than inside the modal so the toolbar can say a draft
   * exists — the modal unmounts when it closes, and state that unmounts with
   * the box is exactly the state that was being lost.
   */
  const { draft, save, clear } = useDraft(DRAFT_KEY);
  const draftWaiting = hasContent(draft);
  /* Whether the composer OPENED onto existing text, which is the only moment
     worth saying so. Captured when it opens rather than derived from the draft,
     or the notice would still be there after the reader had typed a page. */
  const [resumedDraft, setResumedDraft] = useState(false);
  /* Asked before deleting, because a swipe is easy to make by accident and the
     message names what is about to go. */
  const [pendingDelete, setPendingDelete] = useState<Message | null>(null);

  const [filter, setFilter] = useState<InboxFilter>("All");
  const [category, setCategory] = useState<MsgCategory | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<InboxSort>("newest");
  const [selectedId, setSelectedId] = useState(messages[0]?.id ?? "");
  /*
     On a phone the reader is its own screen, not a card under the list.

     Below `@min-[720px]` the three panels stack, so a selected message rendered
     underneath the whole list: to read it you scrolled past every other message
     first, and with nothing selected a "No message selected." card sat there
     taking room and saying nothing. The list IS the page at that width, and
     opening a message should open it — which is exactly what the contacts page
     already does, down to the way back.
  */
  const gridRef = useRef<HTMLDivElement>(null);
  const gridWidth = useElementWidth(gridRef);
  const stacked = gridWidth < 720;
  const [showReader, setShowReader] = useState(false);
  /* Both derived and deliberately not synced: every decision below is gated on
     `stacked`, so on a wide layout these are false whatever `showReader` holds.
     There is no state to correct, only state to ignore. */
  const listOnly = stacked && !showReader;
  const readerOnly = stacked && showReader;

  const [composeOpen, setComposeOpen] = useState(false);
  useOpenFromQuery("compose", useCallback(() => setComposeOpen(true), []));
  const [busy, setBusy] = useState(false);

  /**
   * How the inbox can be ordered.
   *
   * Newest first is the default because an inbox is a queue — the thing that
   * arrived last is the thing nobody has dealt with. "Unread first" is the one
   * that earns its place on a busy account: it puts the work at the top without
   * hiding anything, which a filter would.
   */
  const list = useMemo(() => {
    const byFolder = (() => {
      switch (filter) {
        case "Unread":
          return messages.filter((m) => m.unread && !m.trashed);
        case "Assigned to me":
          return messages.filter((m) => m.assigned && !m.trashed);
        case "Sent":
          return messages.filter((m) => m.direction === "sent" && !m.trashed);
        case "Received":
          return messages.filter((m) => m.direction === "received" && !m.trashed);
        case "Trash":
          return messages.filter((m) => m.trashed);
        default:
          return messages.filter((m) => !m.trashed);
      }
    })();

    const byCategory = category ? byFolder.filter((m) => m.category === category) : byFolder;

    const q = query.trim().toLowerCase();
    if (!q) return sortMessages(byCategory, sort);

    // Search covers the body too — the useful search is usually for something
    // said inside a message, not just its subject line.
    return sortMessages(
      byCategory.filter((m) =>
        [m.name, m.subject, m.preview, m.company, m.email, ...m.body].some((f) =>
          f.toLowerCase().includes(q)
        )
      ),
      sort
    );
  }, [filter, category, query, messages, sort]);

  // Counts come from the same folder the user is looking at, so a chip never
  // promises results that the current folder would filter away.
  const counts = useMemo(() => {
    const scope = filter === "Trash" ? messages.filter((m) => m.trashed) : messages.filter((m) => !m.trashed);
    const out = {} as Record<MsgCategory, number>;
    for (const c of MSG_CATEGORIES) out[c] = scope.filter((m) => m.category === c).length;
    return out;
  }, [filter, messages]);

  const selected = messages.find((m) => m.id === selectedId) ?? list[0] ?? messages[0];

  function handleSelect(id: string) {
    setSelectedId(id);
    setShowReader(true);
    const msg = messages.find((m) => m.id === id);
    if (msg?.unread) markReadAction(id);
  }

  async function handleCompose(formData: FormData) {
    setBusy(true);
    try {
      const id = await addMessageAction(formData);
      setComposeOpen(false);
      if (id) {
        setFilter("Sent");
        setCategory(null);
        setSelectedId(id);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleTrash(id: string) {
    setBusy(true);
    try {
      await trashMessageAction(id);
      const remaining = messages.filter((m) => m.id !== id && !m.trashed);
      setSelectedId(remaining[0]?.id ?? messages[0]?.id ?? "");
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore(id: string) {
    setBusy(true);
    try {
      await restoreMessageAction(id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex h-auto max-w-[1500px] animate-fade-up flex-col gap-4 @min-[1100px]:h-full">
      {/* Chips and folder tabs stick to the top of the scroller.
          These are controls, not headings: letting them scroll away meant they
          were sliced in half at the scroller's top edge on the way out, which
          reads as a clipping bug. `-mt-1 pt-1` swallows `<main>`'s own top
          padding so nothing peeks above the block.

          The frosted backing only exists below the three-column threshold. At
          and above it this page is a fixed-height layout whose columns scroll
          internally, so nothing ever passes beneath these controls — a backing
          there is decoration, and painted over `.app-aurora` it read as a slab
          across the top of the page. Below it the page really does scroll, and
          the frost is what the message list disappears behind. */}
      {/* Hidden while a message is open on a phone. Folders are how you choose
          what to read; once you are reading, they are 72px of navigation to
          somewhere you have already been. The reader gets the screen, and the
          way back is the button above it. */}
      <div
        className={clsx(
          "sticky-head -mt-1 flex flex-col gap-4 pb-2 pt-1 @min-[1100px]:before:hidden",
          readerOnly && "hidden"
        )}
      >
        {/* Category chips. These were decoration — a message had no category,
            so there was nothing for them to filter on. They now toggle a real
            filter and carry live counts. */}
        {/*
            Desktop only, from `@min-[720px]` up.

            Measured at 393px: this row is 134px of a 234px header, on a content
            area of 770 — and on a quiet account every one of its five counts
            reads 0. Two ways of slicing the inbox were stacked on top of each
            other, folders above and categories below, so the reader passed
            eleven filter controls before the first message.

            Categories are a facet, not a place you live, so on a phone they
            move behind one control in the list's own toolbar — beside the
            search and sort that are already there, which is exactly where the
            Contacts list puts its filter. Nothing is lost and 134px comes back.
        */}
        <div className="tab-row hidden flex-wrap items-center gap-2.5 @min-[720px]:flex">
        {MSG_CATEGORIES.map((c) => {
          const meta = CHIP_META[c];
          const Icon = meta.icon;
          const active = category === c;
          const n = counts[c];
          return (
            <button
              key={c}
              onClick={() => setCategory(active ? null : c)}
              aria-pressed={active}
              disabled={n === 0 && !active}
              className={clsx(
                "focus-ring flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-medium transition-colors",
                active ? "border-transparent" : "btn-soft border-transparent",
                n === 0 && !active && "opacity-45"
              )}
              style={active ? { background: meta.soft, color: meta.tone } : { color: meta.tone }}
            >
              <Icon className="h-[16px] w-[16px]" />
              <span className={active ? "" : "text-[var(--text)]"}>{c}</span>
              <span className="text-xs text-faint">{n}</span>
            </button>
          );
        })}
        {category && (
          <button onClick={() => setCategory(null)} className="focus-ring text-xs text-faint hover:text-[var(--text)]">
            Clear
          </button>
        )}
        <button
          onClick={() => {
            setResumedDraft(hasContent(draft));
            setComposeOpen(true);
          }}
          className="btn-accent focus-ring ml-auto flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold"
        >
          <Plus className="h-[16px] w-[16px]" />
          {/* Named rather than badged, because there is room to. A button that
              silently reopened someone's unfinished mail would be a surprise. */}
          {draftWaiting ? "Continue Draft" : "Create New Email"}
        </button>
      </div>

        {/* Folder tabs */}
      <div className="tab-row flex flex-wrap items-center gap-2">
        {inboxFilters.map((f) => {
          const active = filter === f;
          const count = f === "Unread" ? messages.filter((m) => m.unread && !m.trashed).length : undefined;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={clsx(
                "focus-ring rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                active ? "text-accent" : "text-muted hover:text-[var(--text)]"
              )}
              style={active ? { background: "var(--accent-soft)" } : undefined}
            >
              {f}
              {count ? <span className="ml-1.5 text-xs text-faint">{count}</span> : null}
            </button>
          );
        })}
        </div>
      </div>

      {/* The reader is the point of this page, so it gets a floor of its own.
          Three columns only once 340 + 400 + 320 + 32px of gaps actually fit;
          before that the list and reader share the width and the sender card
          moves underneath, which beats crushing the message to 268px. */}
      <div
        ref={gridRef}
        className={clsx(
          "grid min-h-0 flex-1 grid-cols-1 gap-4",
          "@min-[720px]:grid-cols-[minmax(0,300px)_minmax(0,1fr)]",
          "@min-[720px]:[grid-template-areas:'list_reader''card_card']",
          "@min-[1100px]:grid-cols-[minmax(0,340px)_minmax(400px,1fr)_minmax(0,320px)]",
          "@min-[1100px]:[grid-template-areas:'list_reader_card']"
        )}
      >
        {readerOnly && (
          /* The way back, before the thing it returns from — the same control
             the contacts detail uses, in the same place. */
          <button
            type="button"
            onClick={() => setShowReader(false)}
            className="btn-soft focus-ring flex items-center gap-2 self-start rounded-xl px-3 py-2 text-sm font-medium"
          >
            <ChevronLeft className="h-4 w-4" /> All messages
          </button>
        )}
        <MessageList
          className={clsx("@min-[720px]:[grid-area:list]", readerOnly && "hidden")}
          categories={MSG_CATEGORIES}
          counts={counts}
          category={category}
          setCategory={setCategory}
          onCompose={() => {
            setResumedDraft(hasContent(draft));
            setComposeOpen(true);
          }}
          draftWaiting={draftWaiting}
          onAskDelete={setPendingDelete}
          filter={filter}
          list={list}
          selectedId={selected?.id ?? ""}
          onSelect={handleSelect}
          query={query}
          setQuery={setQuery}
          sort={sort}
          setSort={setSort}
        />
        {selected ? (
          <Reader
            className={clsx("@min-[720px]:[grid-area:reader]", listOnly && "hidden")}
            key={selected.id}
            message={selected}
            people={people}
            recent={recent}
            projects={projects}
            companyFor={companyFor}
            busy={busy}
            onTrash={() => handleTrash(selected.id)}
            onRestore={() => handleRestore(selected.id)}
            onSent={(id) => {
              setFilter("Sent");
              setCategory(null);
              setSelectedId(id);
            }}
          />
        ) : (
          /* Only where there are two columns to fill. Stacked, this card sat
             under the list saying "No message selected." — an answer to a
             question nobody had asked, in the room the messages should have
             had. */
          <div className="card hidden min-h-0 place-items-center p-6 text-sm text-faint @min-[720px]:grid @min-[720px]:[grid-area:reader]">
            No message selected.
          </div>
        )}
        {selected ? (
          <ContactCard
            className={clsx("@min-[720px]:[grid-area:card]", listOnly && "hidden")}
            message={selected}
            messages={messages}
            contactId={contactFor[selected.id]}
            revenue={revenueFor[contactFor[selected.id]]}
          />
        ) : (
          /* An empty card is a desktop grid cell holding its column open, and
             nothing at all on a phone. */
          <div className="card hidden @min-[720px]:block @min-[720px]:[grid-area:card]" />
        )}
      </div>

      {pendingDelete && (
        <ConfirmDelete
          message={pendingDelete}
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            const target = pendingDelete;
            setPendingDelete(null);
            await handleTrash(target.id);
          }}
        />
      )}

      {composeOpen && (
        <ComposeModal
          people={people}
          recent={recent}
          busy={busy}
          onClose={() => setComposeOpen(false)}
          onSubmit={handleCompose}
          draft={draft}
          save={save}
          clear={clear}
          restored={resumedDraft}
        />
      )}
    </div>
  );
}

/* ---------------- Message list ---------------- */

function MessageList({
  list,
  selectedId,
  onSelect,
  query,
  setQuery,
  className,
  sort,
  setSort,
  categories,
  counts,
  category,
  setCategory,
  onCompose,
  draftWaiting,
  onAskDelete,
  filter,
}: {
  list: Message[];
  selectedId: string;
  onSelect: (id: string) => void;
  query: string;
  setQuery: (q: string) => void;
  className?: string;
  sort: InboxSort;
  setSort: (s: InboxSort) => void;
  /* The category facet, which lives up here on a desktop and behind the filter
     button below `@min-[720px]`. See the chip row in the sticky head. */
  categories: readonly MsgCategory[];
  counts: Record<MsgCategory, number>;
  category: MsgCategory | null;
  setCategory: (c: MsgCategory | null) => void;
  onCompose: () => void;
  /** A message is part-written, so the button offers to go back to it. */
  draftWaiting: boolean;
  onAskDelete: (m: Message) => void;
  /** Which folder is showing — Trash says how long its contents survive. */
  filter: InboxFilter;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterAnchor, setFilterAnchor] = useState<HTMLButtonElement | null>(null);
  /*
     The toolbar carries two more controls on a phone — the category filter and
     Compose — which left the search field 145px wide. "Search messages" then
     rendered as "Search me" on a real iPhone, whose metrics run slightly wider
     than the ones measured here.

     A shorter label rather than a truncated one, the same trade the app header
     already makes. Measured off the element rather than the viewport, because
     the two extra controls only exist below `@min-[720px]` and it is their
     presence, not the screen size, that makes the field tight.
  */
  const toolbarRef = useRef<HTMLDivElement>(null);
  const narrowToolbar = useElementWidth(toolbarRef) < 720;
  return (
    <div className={clsx("card flex min-h-0 flex-col overflow-hidden p-3", className)}>
      <div ref={toolbarRef} className="mb-2 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-faint" />
        {/* Was a decorative input wired to nothing. */}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={narrowToolbar ? "Search" : "Search messages"}
          className="field-bare"
        />
        {query && (
          <button onClick={() => setQuery("")} className="focus-ring shrink-0 text-faint hover:text-[var(--text)]" aria-label="Clear search">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        </div>
        <SortMenu options={INBOX_SORTS} value={sort} onChange={setSort} defaultId="newest" />

        {/*
            The category facet and Compose, on a phone only.

            Both used to sit in a 134px block above the folder tabs. Here they
            are two 36px controls in a toolbar that already existed, in the same
            arrangement the Contacts list uses — search, sort, filter, then the
            accent primary action.
        */}
        <div className="@min-[720px]:hidden">
          <button
            ref={setFilterAnchor}
            type="button"
            onClick={() => setFilterOpen((v) => !v)}
            aria-expanded={filterOpen}
            title="Filter by type"
            className={clsx(
              "focus-ring grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors",
              category ? "text-accent" : "btn-soft text-muted"
            )}
            style={category ? { background: "var(--accent-soft)" } : undefined}
          >
            <Filter className="h-4 w-4" />
          </button>
          {/* Portalled, like the sort menu beside it — the list card clips
              anything absolutely positioned inside it. */}
          <AnchoredMenu anchor={filterAnchor} open={filterOpen} onClose={() => setFilterOpen(false)}>
            <button
              onClick={() => { setCategory(null); setFilterOpen(false); }}
              className={clsx(
                "focus-ring flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm",
                category === null ? "text-accent" : "text-muted hover:bg-[var(--raise)]"
              )}
            >
              All types
            </button>
            {categories.map((c) => {
              const meta = CHIP_META[c];
              const Icon = meta.icon;
              const n = counts[c];
              return (
                <button
                  key={c}
                  onClick={() => { setCategory(category === c ? null : c); setFilterOpen(false); }}
                  /* Nothing to show is not worth a tap, and saying so is better
                     than a row that silently returns an empty list. */
                  disabled={n === 0 && category !== c}
                  className={clsx(
                    "focus-ring flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm",
                    category === c ? "bg-[var(--raise)]" : "hover:bg-[var(--raise)]",
                    n === 0 && category !== c && "opacity-45"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" style={{ color: meta.tone }} />
                  <span className="min-w-0 flex-1 truncate text-left">{c}</span>
                  <span className="text-xs text-faint">{n}</span>
                </button>
              );
            })}
          </AnchoredMenu>
        </div>
        <button
          type="button"
          onClick={onCompose}
          aria-label={draftWaiting ? "Continue your draft email" : "Create new email"}
          title={draftWaiting ? "Continue your draft" : "Create new email"}
          className="btn-accent focus-ring relative grid h-9 w-9 shrink-0 place-items-center rounded-full @min-[720px]:hidden"
        >
          <Plus className="h-4 w-4" />
          {/* No room for the word on a 36px button, so a dot — and the label
              above says it for anyone who cannot see the dot. */}
          {draftWaiting && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--bg)] bg-[var(--amber,#f59e0b)]"
            />
          )}
        </button>
      </div>
      <div className="-m-1 flex flex-1 scroll-p-1 flex-col gap-2 overflow-y-auto p-1">
        {/* Said in the folder it applies to, so the 7 days in the delete
            confirmation is a promise the app is seen to keep. */}
        {filter === "Trash" && list.length > 0 && (
          <p className="px-1 pb-1 text-center text-xs text-faint">
            Deleted messages are removed for good after 7 days.
          </p>
        )}
        {list.length === 0 && <p className="mt-8 text-center text-sm text-faint">No messages here.</p>}
        {list.map((m) => {
          const active = m.id === selectedId;
          const row = (
            <button
              onClick={() => onSelect(m.id)}
              className={clsx(
                "focus-ring rounded-2xl border p-3 text-left transition-colors",
                active ? "border-[var(--amber)]" : "border-[var(--border)] hover:border-[var(--border-strong)]"
              )}
              style={active ? { background: "var(--amber-soft)" } : undefined}
            >
              <div className="flex items-center gap-3">
                {/* 48px box for a 38px avatar: the spare 10px down and right is
                    the badge's, so it never reaches the name or the preview. */}
                <div className="relative h-12 w-12 shrink-0">
                  <Avatar initials={m.initials} color={m.color} />
                  {/* How the message ARRIVED, not where the sender came from.
                      This showed the contact's acquisition source, so a lead
                      who found the business through Facebook two years ago and
                      had just sent a WhatsApp still drew a Facebook badge — on
                      the one screen whose question is what came in and by what
                      route. */}
                  <MessageChannelBadge channel={m.channel} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-2 truncate text-sm font-semibold">
                      {m.name}
                      {m.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />}
                    </p>
                    <TimeAgoShort at={m.at} />
                  </div>
                  <p className="truncate text-xs text-muted">{m.subject}</p>
                </div>
              </div>
              <p className="mt-2 line-clamp-2 text-xs text-faint">{m.preview}</p>
            </button>
          );
          /* Already in the bin: swiping to delete something deleted is a
             gesture with nothing behind it. Trash has Restore instead. */
          if (m.trashed) return <div key={m.id}>{row}</div>;
          return (
            <SwipeToDelete key={m.id} label={`message from ${m.name}`} onDelete={() => onAskDelete(m)}>
              {row}
            </SwipeToDelete>
          );
        })}
      </div>
    </div>
  );
}

/** The list is dense, so only the relative half fits. */
function TimeAgoShort({ at }: { at: string }) {
  if (!at) return <span className="shrink-0 text-xs text-faint">—</span>;
  return <TimeAgo at={at} mode="relative" className="shrink-0 whitespace-nowrap text-xs text-faint" />;
}

/* ---------------- Reader ---------------- */

function Reader({
  message,
  people,
  recent,
  projects,
  companyFor,
  busy,
  onTrash,
  onRestore,
  onSent,
  className,
}: {
  message: Message;
  people: Person[];
  recent: Person[];
  /** Live projects this conversation could belong to. The sender's own first. */
  projects: ProjectOption[];
  /** Contact id → company id, so the sender's own jobs can be marked. */
  companyFor: Record<string, string>;
  busy: boolean;
  onTrash: () => void;
  onRestore: () => void;
  onSent: (id: string) => void;
  className?: string;
}) {
  // Reset on message change is handled by the `key` the parent passes, which
  // remounts this component — the React way to say "this is a different thing
  // now". Doing it with an effect would mean rendering the previous message's
  // open composer once before clearing it.
  const [mode, setMode] = useState<null | "reply" | "forward">(null);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [sending, setSending] = useState(false);
  const [forwardTo, setForwardTo] = useState("");

  const addressable = useMemo(() => addressablePeople(people), [people]);
  const addressableRecent = useMemo(() => addressablePeople(recent), [recent]);

  async function submit(formData: FormData) {
    setSending(true);
    try {
      const id = mode === "reply" ? await replyAction(message.id, formData) : await forwardAction(message.id, formData);
      setMode(null);
      if (id) onSent(id);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={clsx("card flex min-h-0 flex-col overflow-hidden p-6", className)}>
      {/* `min-w-0` on both sides and a nowrap timestamp: without them the long
          relative stamp wrapped onto three lines and squeezed the name into a
          two-line column. */}
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] pb-4">
        <div className="flex min-w-0 items-center gap-3">
          {/* The same badge as the list. Knowing you are answering a WhatsApp
              rather than an email changes how you write the reply, so it
              belongs on the screen where the reply is written too. */}
          <div className="relative shrink-0">
            <Avatar initials={message.initials} color={message.color} size="lg" />
            <MessageChannelBadge channel={message.channel} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">{message.name}</p>
            {message.at ? (
              <TimeAgo at={message.at} mode="relative" className="block truncate text-xs text-faint" />
            ) : (
              <p className="text-xs text-faint">No timestamp recorded</p>
            )}
            {/* In the header's own column rather than a band of its own.

                Measured on a 375px screen: as a separate bordered row it cost
                60px — exactly as tall as this header — while the message
                itself had 107px. A fifth of the card, and the tallest thing on
                it after the body, for one piece of metadata. Here it costs
                about 24px and the body gets the difference. */}
            <FileUnderProject message={message} projects={projects} companyFor={companyFor} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {message.trashed ? (
            <button
              onClick={onRestore}
              disabled={busy}
              className="focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-[var(--raise)] disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" /> Restore
            </button>
          ) : (
            <button
              onClick={onTrash}
              disabled={busy}
              className="focus-ring grid h-9 w-9 place-items-center rounded-full text-faint transition-colors hover:text-[var(--red)] disabled:opacity-50"
              aria-label="Delete message"
            >
              <Trash2 className="h-[18px] w-[18px]" />
            </button>
          )}
        </div>
      </div>

      <div className="-mx-1 flex-1 scroll-p-1 overflow-y-auto px-1 py-5">
        {/* The category sits with the subject, not in the header row — beside
            the name and the delete button it left no room for either. */}
        {message.category && (
          <span
            className="mb-2 inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-bold"
            style={{ background: CHIP_META[message.category].soft, color: CHIP_META[message.category].tone }}
          >
            {message.category.toUpperCase()}
          </span>
        )}
        <h2 className="text-xl font-semibold tracking-tight">{message.subject}</h2>
        <div className="mt-4 space-y-4 text-sm leading-relaxed text-muted">
          {message.body.map((p, i) => (
            <p key={i} className="whitespace-pre-line">
              {p}
            </p>
          ))}
        </div>

        {message.attachments.length > 0 && (
          <div className="mt-7">
            <p className="text-sm font-medium">
              {message.attachments.length} Attachment{message.attachments.length > 1 ? "s" : ""}
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              {/* Attachment cards were static — name and size only, with no
                  file behind them, so there was nothing a click could open.
                  Ones with stored text now open in a viewer. */}
              {message.attachments.map((a) => (
                <button
                  key={a.name}
                  onClick={() => a.content && setViewing(a)}
                  disabled={!a.content}
                  title={a.content ? `Open ${a.name}` : "No file stored for this attachment"}
                  className={clsx(
                    "focus-ring flex items-center gap-3 rounded-2xl border border-[var(--border)] p-3 pr-5 text-left transition-colors",
                    a.content ? "hover:border-[var(--border-strong)] hover:bg-[var(--raise)]" : "opacity-60"
                  )}
                >
                  <FileIcon kind={a.kind} />
                  <div className="leading-tight">
                    <p className="text-sm font-medium">{a.name}</p>
                    <p className="text-xs text-faint">{a.content ? a.size : "Not stored"}</p>
                  </div>
                  {a.content && <ExternalLink className="ml-1 h-3.5 w-3.5 shrink-0 text-faint" />}
                </button>
              ))}
            </div>
          </div>
        )}

        {mode && (
          <form action={submit} className="mt-6 rounded-2xl border border-[var(--border)] p-4">
            <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
              {mode === "reply" ? (
                <>
                  <CornerUpLeft className="h-4 w-4 text-accent" /> Reply to {message.name}
                </>
              ) : (
                <>
                  <CornerUpRight className="h-4 w-4 text-accent" /> Forward this message
                </>
              )}
            </p>

            {mode === "forward" && (
              <div className="mb-3 block">
                <span className="mb-1.5 block text-xs font-medium text-muted">
                  To<span className="text-[var(--red)]"> *</span>
                </span>
                {/* Suggests as you type, the same as the composer does. This
                    was a bare text box: forwarding meant recalling an address
                    from memory and typing it correctly, in a CRM that already
                    holds every one of them. Getting it wrong is silent — the
                    message sends, to nobody who exists.

                    Still accepts a raw address, so forwarding to someone not on
                    file is not blocked by the field that is meant to help. */}
                <PersonField
                  value={forwardTo}
                  onChange={setForwardTo}
                  onPick={(p) => setForwardTo(p.email)}
                  people={addressable}
                  recent={addressableRecent}
                  placeholder="Name or email address"
                  autoFocus
                  describe={(p) => p.email}
                />
                <input type="hidden" name="to" value={forwardTo} />
              </div>
            )}

            <textarea
              name="body"
              rows={4}
              required={mode === "reply"}
              autoFocus={mode === "reply"}
              placeholder={mode === "reply" ? `Write your reply to ${message.name}…` : "Add a note (optional)…"}
              className="field-input resize-y"
            />

            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setMode(null)} className="btn-soft focus-ring rounded-xl px-4 py-2 text-sm font-medium">
                Cancel
              </button>
              {/* `required` cannot guard a hidden input, so the button does it —
                  the same guard the composer uses. Without it a forward with an
                  empty To would post and the action would file it under a
                  recipient nobody typed. */}
              <button
                type="submit"
                disabled={sending || (mode === "forward" && !forwardTo.trim())}
                className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60"
              >
                <Send className="h-4 w-4" />
                {sending ? "Sending…" : mode === "reply" ? "Send reply" : "Forward"}
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-[var(--border)] pt-4">
        <button
          onClick={() => setMode(mode === "reply" ? null : "reply")}
          className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold"
        >
          <CornerUpLeft className="h-4 w-4" />
          Reply
        </button>
        <button
          onClick={() => setMode(mode === "forward" ? null : "forward")}
          className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium"
        >
          <CornerUpRight className="h-4 w-4" />
          Forward
        </button>
      </div>

      {viewing && <AttachmentViewer attachment={viewing} from={message.name} onClose={() => setViewing(null)} />}
    </div>
  );
}

function AttachmentViewer({
  attachment,
  from,
  onClose,
}: {
  attachment: Attachment;
  from: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portalled to <body> on purpose. This viewer is rendered from inside the
  // reader's `.card`, and that card sets `backdrop-filter` — which makes it the
  // containing block for `position: fixed`. Left in place, the "full-screen"
  // overlay was trapped inside the middle column instead of covering the page.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="modal-surface relative z-10 flex w-full max-w-2xl flex-col p-6">
        <div className="mb-4 flex items-start justify-between gap-3 border-b border-[var(--border)] pb-4">
          <div className="flex items-center gap-3">
            <FileIcon kind={attachment.kind} />
            <div className="leading-tight">
              <p className="font-semibold">{attachment.name}</p>
              <p className="text-xs text-faint">
                {attachment.size} · from {from}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-faint hover:text-[var(--text)]" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <pre className="flex-1 overflow-auto whitespace-pre-wrap rounded-xl p-4 font-mono text-[13px] leading-relaxed text-[var(--text)]" style={{ background: "var(--raise)" }}>
          {attachment.content}
        </pre>

        <p className="mt-4 flex items-center gap-2 text-xs text-faint">
          <FileText className="h-3.5 w-3.5" />
          Ask the assistant <Link href="/chat" className="focus-ring rounded text-accent hover:underline">in Chat</Link> to explain this
          document — it can read the contents.
        </p>
      </div>
    </div>,
    document.body
  );
}

function FileIcon({ kind }: { kind: Attachment["kind"] }) {
  const map = {
    pdf: { label: "PDF", color: "var(--red)", soft: "var(--red-soft)" },
    doc: { label: "DOC", color: "var(--accent)", soft: "var(--accent-soft)" },
    txt: { label: "TXT", color: "var(--text-muted)", soft: "var(--raise)" },
  } as const;
  const m = map[kind] ?? map.txt;
  return (
    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-[10px] font-bold" style={{ background: m.soft, color: m.color }}>
      {m.label}
    </span>
  );
}

/* ---------------- Contact card ---------------- */

function ContactCard({
  message,
  messages,
  contactId,
  revenue,
  className,
}: {
  message: Message;
  messages: Message[];
  contactId?: string;
  revenue?: ContactRevenue;
  className?: string;
}) {
  /*
     Which of the two in-place actions is open, if either.

     Revenue and Note used to be links. "Note" pointed at
     `/contacts?open=<id>` — the SAME destination as the last button beside it,
     so two of the six did the identical thing and neither of them took a note.
     "Revenue" opened the whole deals board, which is not this person's revenue.
     Both now answer where they were asked.
  */
  const [panel, setPanel] = useState<"revenue" | "note" | null>(null);
  const [noteSaved, setNoteSaved] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const tel = message.phone.replace(/[^\d+]/g, "");
  const hasEmail = message.email && message.email !== "—";

  /**
   * First and latest contact, derived from the messages themselves so they
   * cannot go stale — they used to be stored strings nothing recomputed.
   *
   * Gathered by CONTACT ID. It used to match on the sender's email or their
   * name, and a name is not an identity: correcting a spelling split one
   * person's history in two, and nothing said it had happened. Email is the
   * fallback only for messages that arrived before the sender was a contact,
   * where there is no id to match on and an address is the best available
   * identity.
   */
  const thread = useMemo(() => {
    const sameSender = (m: (typeof messages)[number]) => {
      if (message.contactId && m.contactId) return m.contactId === message.contactId;
      if (!message.email || message.email === "—") return m.id === message.id;
      return m.email.toLowerCase() === message.email.toLowerCase();
    };

    const mine = messages
      .filter((m) => m.at && sameSender(m))
      .map((m) => m.at)
      .sort();
    return { first: mine[0], latest: mine[mine.length - 1], count: mine.length };
  }, [messages, message.contactId, message.email, message.id]);

  const actions = [
    { label: "Call", icon: Phone, href: tel ? `tel:${tel}` : undefined, why: tel ? `Call ${message.phone}` : "No phone number" },
    { label: "Text", icon: MessageCircle, href: tel ? `sms:${tel}` : undefined, why: tel ? `Text ${message.phone}` : "No phone number" },
    { label: "Email", icon: Mail, href: hasEmail ? `mailto:${message.email}` : undefined, why: hasEmail ? `Email ${message.email}` : "No email address" },
    {
      label: "Revenue",
      icon: DollarSign,
      /* Answered here rather than by navigating to the deals board, which
         showed everybody's deals and called it this person's revenue. */
      onClick: contactId ? () => setPanel((p) => (p === "revenue" ? null : "revenue")) : undefined,
      why: contactId ? "What this contact is worth" : "Not in your contacts yet",
    },
    {
      label: "Note",
      icon: StickyNote,
      /* Actually takes the note. This pointed at the contact record — the same
         place as the button beside it — so it moved you somewhere to go and
         find the real Note button. */
      onClick: contactId ? () => setPanel((p) => (p === "note" ? null : "note")) : undefined,
      why: contactId ? "Add a note against this contact" : "Not in your contacts yet",
    },
    {
      label: "Contact",
      icon: MoreHorizontal,
      href: contactId ? `/contacts?open=${contactId}` : undefined,
      why: contactId ? "Open the full contact record" : "Not in your contacts yet",
    },
  ];

  const mapsUrl = message.location
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(message.location)}`
    : null;

  return (
    <div className={clsx("card flex min-h-0 flex-col overflow-y-auto p-5", className)}>
      <div className="flex items-start gap-3">
        <Avatar initials={message.initials} color={message.color} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-base font-semibold">
            <span className="truncate">{message.name}</span>
            {contactId && <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--green)]" />}
          </p>
          <p className="truncate text-xs text-faint">{message.role}</p>
        </div>
      </div>

      {/* Every one of these did nothing. */}
      <div className="mt-5 grid grid-cols-6 gap-1">
        {actions.map((a) => {
          const Icon = a.icon;
          const body = (
            <>
              <span
                className={clsx(
                  "btn-soft grid h-9 w-9 place-items-center rounded-full transition-transform",
                  a.href && "group-hover:-translate-y-0.5"
                )}
              >
                <Icon className={clsx("h-4 w-4", a.href ? "text-accent" : "text-faint")} />
              </span>
              <span className={clsx("text-[10px]", a.href ? "text-muted" : "text-faint")}>{a.label}</span>
            </>
          );

          if (a.onClick) {
            const open = (a.label === "Revenue" && panel === "revenue") || (a.label === "Note" && panel === "note");
            return (
              <button
                key={a.label}
                type="button"
                onClick={a.onClick}
                title={a.why}
                aria-expanded={open}
                className="focus-ring group flex flex-col items-center gap-1"
              >
                {body}
              </button>
            );
          }

          return a.href ? (
            a.href.startsWith("/") ? (
              <Link key={a.label} href={a.href} title={a.why} className="focus-ring group flex flex-col items-center gap-1">
                {body}
              </Link>
            ) : (
              <a key={a.label} href={a.href} title={a.why} className="focus-ring group flex flex-col items-center gap-1">
                {body}
              </a>
            )
          ) : (
            <span key={a.label} title={a.why} className="flex cursor-not-allowed flex-col items-center gap-1 opacity-50">
              {body}
            </span>
          );
        })}
      </div>

      {/* The answer, where the question was asked. */}
      {panel === "revenue" && contactId && (
        <div className="mt-4 rounded-xl border border-[var(--border)] p-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Won</p>
              <p className="mt-0.5 text-lg font-bold tabular-nums text-[var(--green)]">
                {money(revenue?.won ?? 0)}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">In pipeline</p>
              <p className="mt-0.5 text-lg font-bold tabular-nums">{money(revenue?.open ?? 0)}</p>
            </div>
          </div>
          {/* Says where the figures come from rather than leaving two numbers
              floating; and a way through to the board for the detail. */}
          <p className="mt-2 text-[11px] text-faint">
            {revenue?.deals
              ? `Across ${revenue.deals} deal${revenue.deals === 1 ? "" : "s"}.`
              : "No deals recorded against this contact yet."}{" "}
            <Link href={`/contacts?open=${contactId}`} className="focus-ring rounded text-accent hover:underline">
              Open contact
            </Link>
          </p>
        </div>
      )}

      {panel === "note" && contactId && (
        <form
          className="mt-4 rounded-xl border border-[var(--border)] p-3"
          action={async (formData: FormData) => {
            setSavingNote(true);
            try {
              await addNoteAction(contactId, formData);
              /* Confirmed in place. The note lands on the contact's timeline,
                 which is a different screen — so without a word here the only
                 feedback would be the box emptying. */
              setNoteSaved(true);
            } finally {
              setSavingNote(false);
            }
          }}
        >
          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
              Add a note
            </span>
            <textarea
              name="note"
              rows={3}
              required
              autoFocus
              onChange={() => setNoteSaved(false)}
              placeholder={`What did ${message.name.split(/\s+/)[0]} say?`}
              className="field-input mt-1.5 resize-none"
            />
          </label>
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-[11px] text-faint">
              {noteSaved ? "Saved to their timeline." : "Saved against this contact."}
            </p>
            <button
              type="submit"
              disabled={savingNote}
              className="btn-accent focus-ring rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
            >
              {savingNote ? "Saving…" : "Save note"}
            </button>
          </div>
        </form>
      )}

      <p className="mt-6 mb-3 border-t border-[var(--border)] pt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        Contact Details
      </p>

      <Detail label="Email">
        {hasEmail ? (
          <a href={`mailto:${message.email}`} className="focus-ring rounded text-accent hover:underline">
            {message.email}
          </a>
        ) : (
          <span className="text-faint">Not on file</span>
        )}
      </Detail>

      <Detail label="Phone">
        {tel ? (
          <a href={`tel:${tel}`} className="focus-ring rounded text-accent hover:underline">
            {message.phone}
          </a>
        ) : (
          <span className="text-faint">Not on file</span>
        )}
      </Detail>

      {/* Was a decorative map graphic with a "Location Address" link pointing at
          "#". It now states where the business actually is and opens it. */}
      <Detail label="Business location">
        {message.location ? (
          <a
            href={mapsUrl!}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring inline-flex items-center gap-1.5 rounded text-accent hover:underline"
          >
            <MapPin className="h-3.5 w-3.5 shrink-0" />
            {message.location}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        ) : (
          <span className="text-faint">Not on file</span>
        )}
      </Detail>

      <Detail label="Their local time">
        {message.timeZone ? (
          <ClientClock timeZone={message.timeZone} className="text-[var(--text)]" />
        ) : (
          <span className="text-faint">Time zone not on file</span>
        )}
      </Detail>

      <Detail label="Languages">
        <span className="text-[var(--text)]">{message.language}</span>
      </Detail>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <InteractionCard dotColor="var(--green)" title="First message" at={thread.first} />
        <InteractionCard dotColor="var(--red)" title="Latest message" at={thread.latest} />
      </div>

      {thread.count > 1 && (
        <p className="mt-3 text-center text-[11px] text-faint">
          {thread.count} messages in this thread
        </p>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <p className="mb-1 text-[11px] text-faint">{label}</p>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

function InteractionCard({ dotColor, title, at }: { dotColor: string; title: string; at?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dotColor }} />
        {title}
      </p>
      {at ? (
        <TimeAgo at={at} className="mt-2 block text-xs font-semibold" />
      ) : (
        <p className="mt-2 text-xs text-faint">No record</p>
      )}
    </div>
  );
}

/* ---------------- Compose modal ---------------- */

/**
 * Confirming a delete that was started with a gesture.
 *
 * A swipe is easy to make by accident on a moving train, so the row asks. It
 * names the sender and says where the message goes, because "Delete" alone
 * reads as gone forever and this is not that.
 */
function ConfirmDelete({
  message,
  busy,
  onCancel,
  onConfirm,
}: {
  message: Message;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <Overlay>
      <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
        <div className="modal-surface relative z-10 w-full max-w-sm p-6">
          <h2 className="text-lg font-semibold tracking-tight">Delete this message?</h2>
          <p className="mt-2 text-sm text-muted">
            <span className="font-medium text-[var(--text)]">{message.subject || "(no subject)"}</span> from{" "}
            {message.name} moves to Trash, where it stays for 7 days before it is removed for good.
          </p>
          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="btn-soft focus-ring rounded-xl px-5 py-2.5 text-sm font-medium"
            >
              Keep it
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="focus-ring flex items-center gap-2 rounded-xl bg-[var(--red)] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" /> Move to Trash
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

function ComposeModal({
  people,
  recent,
  draft,
  save,
  clear,
  restored,
  busy,
  onClose,
  onSubmit,
}: {
  people: Person[];
  recent: Person[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (formData: FormData) => void | Promise<void>;
  draft: Draft;
  save: (d: Draft) => void;
  clear: () => void;
  restored: boolean;
}) {
  const to = draft.to;
  const setTo = (v: string) => save({ ...draft, to: v });

  const addressable = useMemo(() => addressablePeople(people), [people]);
  const addressableRecent = useMemo(() => addressablePeople(recent), [recent]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* Portalled, like every other overlay in this app. This composer is written
     inside the page root, and that root carries `animate-fade-up` — whose final
     keyframe leaves an identity `transform` on the computed style. An identity
     transform still makes an element the containing block for `position: fixed`,
     so `inset-0` resolved to the page root rather than to the window. Measured
     at 393x850 with the list empty: the root was 224px tall starting at y=84, so
     a 510px panel centred inside it landed at y=-59 — the title and the To field
     above the top of the screen, "Subject" the first thing visible. Exactly what
     the recording showed. */
  return (
    <Overlay>
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      {/* Opaque — see the note on `.modal-surface`. */}
      <form
        action={async (formData: FormData) => {
          /* Cleared after, and only after. Clearing on submit would throw the
             message away on the one occasion it matters most — a send that
             failed. */
          await onSubmit(formData);
          clear();
        }}
        className="modal-surface relative z-10 w-full max-w-lg p-6"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Send className="h-[18px] w-[18px] text-accent" /> New Email
          </h2>
          <button type="button" onClick={onClose} className="text-faint hover:text-[var(--text)]" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Said plainly, once. Fields that quietly refill themselves look like
            a bug the first time; saying where the text came from, and offering
            to throw it away, makes it a feature rather than a surprise. */}
        {restored && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] px-3 py-2 text-xs text-muted">
            <span>Picked up where you left off.</span>
            <button
              type="button"
              onClick={clear}
              className="focus-ring shrink-0 rounded-lg px-2 py-1 font-medium text-[var(--red)] hover:bg-[var(--raise)]"
            >
              Discard draft
            </button>
          </div>
        )}

        <div className="space-y-4">
          <div className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">
              To<span className="text-[var(--red)]"> *</span>
            </span>
            {/* Suggests from contacts and leads. Typing a recipient from memory
                was the only option before, in a CRM that already knows every
                one of them. Picking someone fills in their address; the field
                still takes a raw address for anyone not on file. */}
            <PersonField
              value={to}
              onChange={setTo}
              onPick={(p) => setTo(p.email)}
              people={addressable}
              recent={addressableRecent}
              placeholder="Name or email address"
              autoFocus
              describe={(p) => p.email}
            />
            <input type="hidden" name="to" value={to} />
          </div>
          <div className="grid grid-cols-1 gap-4 @min-[440px]:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Subject</span>
              <input
                name="subject"
                value={draft.subject}
                onChange={(e) => save({ ...draft, subject: e.target.value })}
                placeholder="Subject line"
                className="field-input"
              />
            </label>
            {/* Which transport this was.

                It exists because the badge in the list has to be able to say
                something other than "email", and a channel nothing can set is
                an icon that never draws. Recording a WhatsApp conversation is
                a real thing people do; this is where they say so. */}
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Channel</span>
              <select name="channel" defaultValue="email" className="field-input">
                <option value="email">Email</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="sms">SMS</option>
              </select>
            </label>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Message</span>
            <textarea
              name="body"
              rows={5}
              value={draft.body}
              onChange={(e) => save({ ...draft, body: e.target.value })}
              placeholder="Write your message..."
              className="field-input resize-y"
            />
          </label>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          {/* Closing keeps what was written — that is the whole point. The
              word says so, because "Cancel" reads as "throw this away". */}
          <button type="button" onClick={onClose} className="btn-soft focus-ring rounded-xl px-5 py-2.5 text-sm font-medium">
            {hasContent(draft) ? "Save & Close" : "Cancel"}
          </button>
          {/* `required` cannot guard a hidden input, so the button does it. Without
              this an empty To would post and the action would file the message
              under "New Recipient". */}
          <button
            type="submit"
            disabled={busy || !to.trim()}
            className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            <Send className="h-4 w-4" /> {busy ? "Sending…" : "Send Email"}
          </button>
        </div>
      </form>
    </div>
    </Overlay>
  );
}

/**
 * Which project this conversation belongs to.
 *
 * The single most valuable thing you can record about an email in a business
 * that runs on jobs, and until now there was nowhere to put it — mail belonged
 * to a person and to nothing else, so "the thread about the Stellenbosch
 * warehouse" could not be asked for.
 *
 * It files the THREAD, not the message. Replies inherit it automatically, so
 * this is a decision made once per conversation rather than once per email.
 *
 * The sender's own company is marked "suggested" and sorted first, and that is
 * as far as it goes: nothing is filed on the reader's behalf. A guess that puts
 * a client's email on the wrong job is worse than leaving it unfiled, because
 * nobody goes looking for a mistake they were never told about — and the moment
 * a client has two live sites the guess is a coin toss.
 */
function FileUnderProject({
  message,
  projects,
  companyFor,
}: {
  message: Message;
  projects: ProjectOption[];
  companyFor: Record<string, string>;
}) {
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const filed = projects.find((p) => p.id === message.dealId);

  /*
     The sender's own company's jobs, first and marked.

     A suggestion and no more — nothing is filed on the reader's behalf. An
     email put on the wrong job by a guess is worse than one left unfiled,
     because nobody goes looking for a mistake they were never told about, and
     the moment a client has two live sites the guess is a coin toss.
  */
  const senderCompany = message.contactId ? companyFor[message.contactId] : undefined;
  const ordered = useMemo(() => {
    const suggested = (p: ProjectOption) =>
      senderCompany !== undefined && p.companyId === senderCompany;
    return [...projects]
      .map((p) => ({ ...p, suggested: suggested(p) }))
      .sort((a, b) => Number(b.suggested) - Number(a.suggested));
  }, [projects, senderCompany]);

  /* Nothing to file against, and nothing useful to say about it. A dropdown
     with no options is a control that cannot be used. */
  if (projects.length === 0 && !message.dealId) return null;

  async function choose(dealId: string) {
    setSaving(true);
    setResult(null);
    try {
      const r = await fileThreadAction(message.threadId, dealId || null);
      setResult(("ok" in r ? r.ok : r.error) ?? null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
      <Briefcase className="h-3 w-3 shrink-0 text-faint" aria-hidden />
      <label className="sr-only" htmlFor={`file-${message.threadId}`}>
        File this conversation against a project
      </label>
      <select
        id={`file-${message.threadId}`}
        value={message.dealId ?? ""}
        disabled={saving}
        onChange={(e) => choose(e.target.value)}
        /* `max-w-full`, not `flex-1`. Stretched, it filled 218px of a 333px
           card and read as the primary control on a screen whose primary
           control is Reply. Sized to its content it is what it should be:
           a label you can change. */
        className="focus-ring min-w-0 max-w-full truncate rounded-md border border-[var(--border)] px-1.5 py-0.5 font-medium disabled:opacity-60"
        /* The size is set here, not with `text-xs`.

           Measured: the class was on it and the computed size was still 16px,
           which is why it dwarfed the timestamp beside it. A select is a
           replaced element and browsers apply their own font to it; an inline
           style is the one thing that reliably wins. Same reason the Notes
           search sets its padding this way. */
        style={{
          fontSize: 11,
          lineHeight: "16px",
          ...(filed
            ? { background: "var(--accent-soft)", color: "var(--accent)" }
            : { background: "transparent", color: "var(--text-faint)" }),
        }}
      >
        <option value="">Not filed to a project</option>
        {ordered.map((p) => (
          <option key={p.id} value={p.id}>
            {[p.companyName, p.site, p.title].filter(Boolean).join(" · ")}
            {p.suggested ? "  — this sender's client" : ""}
          </option>
        ))}
      </select>

      {/* Truncated rather than wrapped: this sits in the header's column and a
          two-line confirmation would push the message down to say something
          that is already visible in the control itself. */}
      {result && <span className="min-w-0 truncate text-[11px] text-faint">{result}</span>}
    </div>
  );
}
