"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  CalendarCheck,
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
import { ChannelBadge, type ContactChannel } from "@/components/ui/ChannelBadge";
import { ClientClock } from "@/components/ui/ClientClock";
import { PersonField, type Person } from "@/components/ui/PersonField";
import { TimeAgo } from "@/components/ui/TimeAgo";
import {
  inboxFilters,
  MSG_CATEGORIES,
  type Attachment,
  type InboxFilter,
  type Message,
  type MsgCategory,
} from "@/data/inbox";
import { clsx } from "@/lib/clsx";
import { useElementWidth } from "@/lib/use-element-width";
import { AnchoredMenu } from "@/components/ui/AnchoredMenu";
import { Overlay } from "@/components/ui/Overlay";
import { SortMenu } from "@/components/ui/SortMenu";
import { useOpenFromQuery } from "@/lib/useOpenFromQuery";
import {
  addMessageAction,
  forwardAction,
  markReadAction,
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

export function InboxView({
  messages,
  contactFor,
  channelFor,
  people,
}: {
  messages: Message[];
  contactFor: Record<string, string>;
  /** Where each sender came from — a real source, resolved on the server. */
  channelFor: Record<string, ContactChannel>;
  /** Contacts and leads, so addressing a new email is recognition, not recall. */
  people: Person[];
}) {
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
          onClick={() => setComposeOpen(true)}
          className="btn-accent focus-ring ml-auto flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold"
        >
          <Plus className="h-[16px] w-[16px]" />
          Create New Email
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
          onCompose={() => setComposeOpen(true)}
          list={list}
          selectedId={selected?.id ?? ""}
          onSelect={handleSelect}
          query={query}
          setQuery={setQuery}
          channelFor={channelFor}
          sort={sort}
          setSort={setSort}
        />
        {selected ? (
          <Reader
            className={clsx("@min-[720px]:[grid-area:reader]", listOnly && "hidden")}
            key={selected.id}
            message={selected}
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
          />
        ) : (
          /* An empty card is a desktop grid cell holding its column open, and
             nothing at all on a phone. */
          <div className="card hidden @min-[720px]:block @min-[720px]:[grid-area:card]" />
        )}
      </div>

      {composeOpen && (
        <ComposeModal people={people} busy={busy} onClose={() => setComposeOpen(false)} onSubmit={handleCompose} />
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
  channelFor,
  className,
  sort,
  setSort,
  categories,
  counts,
  category,
  setCategory,
  onCompose,
}: {
  list: Message[];
  selectedId: string;
  onSelect: (id: string) => void;
  query: string;
  setQuery: (q: string) => void;
  channelFor: Record<string, ContactChannel>;
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
          aria-label="Create new email"
          title="Create new email"
          className="btn-accent focus-ring grid h-9 w-9 shrink-0 place-items-center rounded-full @min-[720px]:hidden"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <div className="-m-1 flex flex-1 scroll-p-1 flex-col gap-2 overflow-y-auto p-1">
        {list.length === 0 && <p className="mt-8 text-center text-sm text-faint">No messages here.</p>}
        {list.map((m) => {
          const active = m.id === selectedId;
          return (
            <button
              key={m.id}
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
                  <ChannelBadge channel={channelFor[m.id] ?? "Email"} />
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
  busy,
  onTrash,
  onRestore,
  onSent,
  className,
}: {
  message: Message;
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
          <Avatar initials={message.initials} color={message.color} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">{message.name}</p>
            {message.at ? (
              <TimeAgo at={message.at} mode="relative" className="block truncate text-xs text-faint" />
            ) : (
              <p className="text-xs text-faint">No timestamp recorded</p>
            )}
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
              <label className="mb-3 block">
                <span className="mb-1.5 block text-xs font-medium text-muted">
                  To<span className="text-[var(--red)]"> *</span>
                </span>
                <input name="to" required autoFocus placeholder="Name or email address" className="field-input" />
              </label>
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
              <button type="submit" disabled={sending} className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-60">
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
  className,
}: {
  message: Message;
  messages: Message[];
  contactId?: string;
  className?: string;
}) {
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
      href: contactId ? "/deals" : undefined,
      why: contactId ? "See deals for this contact" : "Not in your contacts yet",
    },
    {
      label: "Note",
      icon: StickyNote,
      href: contactId ? `/contacts?open=${contactId}` : undefined,
      why: contactId ? "Add a note on their contact record" : "Not in your contacts yet",
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

function ComposeModal({
  people,
  busy,
  onClose,
  onSubmit,
}: {
  people: Person[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (formData: FormData) => void | Promise<void>;
}) {
  const [to, setTo] = useState("");

  /**
   * Only people you can actually reach.
   *
   * A lead captured from a phone call often has no email address, and offering
   * one as a suggestion here would produce a message that cannot be sent.
   */
  const addressable = useMemo(
    () => people.filter((p) => p.email && p.email.includes("@")),
    [people]
  );

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
      <form action={onSubmit} className="modal-surface relative z-10 w-full max-w-lg p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Send className="h-[18px] w-[18px] text-accent" /> New Email
          </h2>
          <button type="button" onClick={onClose} className="text-faint hover:text-[var(--text)]" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

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
              placeholder="Name or email address"
              autoFocus
              describe={(p) => p.email}
            />
            <input type="hidden" name="to" value={to} />
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Subject</span>
            <input name="subject" placeholder="Subject line" className="field-input" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Message</span>
            <textarea name="body" rows={5} placeholder="Write your message..." className="field-input resize-y" />
          </label>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="btn-soft focus-ring rounded-xl px-5 py-2.5 text-sm font-medium">
            Cancel
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
