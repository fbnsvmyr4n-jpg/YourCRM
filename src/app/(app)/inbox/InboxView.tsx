"use client";

import { useMemo, useState } from "react";
import {
  CalendarCheck,
  ClipboardList,
  CornerUpLeft,
  CornerUpRight,
  DollarSign,
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
import { inboxFilters, type InboxFilter, type Message, type MsgChannel } from "@/data/inbox";
import { clsx } from "@/lib/clsx";
import { addMessageAction, markReadAction, restoreMessageAction, trashMessageAction } from "./actions";

const CHANNEL: Record<MsgChannel, { color: string; soft: string; icon: typeof Mail }> = {
  amber: { color: "var(--amber)", soft: "var(--amber-soft)", icon: Mail },
  green: { color: "var(--green)", soft: "var(--green-soft)", icon: Mail },
  blue: { color: "var(--accent)", soft: "var(--accent-soft)", icon: CornerUpLeft },
};

const chips = [
  { label: "Appointments", icon: CalendarCheck, tone: "var(--accent)" },
  { label: "Tasks", icon: ClipboardList, tone: "var(--amber)" },
  { label: "Meeting Requests", icon: Users, tone: "var(--green)" },
  { label: "Follow-ups", icon: CornerUpLeft, tone: "var(--red)" },
  { label: "Enquiries", icon: MessageCircle, tone: "var(--purple)" },
];

export function InboxView({ messages }: { messages: Message[] }) {
  const [filter, setFilter] = useState<InboxFilter>("All");
  const [selectedId, setSelectedId] = useState(messages[0]?.id ?? "");
  const [composeOpen, setComposeOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
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
  }, [filter, messages]);

  const selected = messages.find((m) => m.id === selectedId) ?? list[0] ?? messages[0];

  function handleSelect(id: string) {
    setSelectedId(id);
    const msg = messages.find((m) => m.id === id);
    if (msg?.unread) markReadAction(id); // fire-and-forget; revalidates the unread state
  }

  async function handleCompose(formData: FormData) {
    setBusy(true);
    try {
      const id = await addMessageAction(formData);
      setComposeOpen(false);
      if (id) {
        setFilter("Sent");
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
    <div className="mx-auto flex h-auto max-w-[1500px] animate-fade-up flex-col gap-4 lg:h-[calc(100vh-104px)]">
      {/* Chips */}
      <div className="flex flex-wrap items-center gap-2.5">
        {chips.map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.label}
              className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium"
              style={{ color: c.tone }}
            >
              <Icon className="h-[16px] w-[16px]" />
              <span className="text-[var(--text)]">{c.label}</span>
            </button>
          );
        })}
        <button
          onClick={() => setComposeOpen(true)}
          className="btn-accent focus-ring ml-auto flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold"
        >
          <Plus className="h-[16px] w-[16px]" />
          Create New Email
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {inboxFilters.map((f) => {
          const active = filter === f;
          const count =
            f === "Unread" ? messages.filter((m) => m.unread && !m.trashed).length : undefined;
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

      {/* 3 columns */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)_minmax(0,320px)]">
        <MessageList list={list} selectedId={selected?.id ?? ""} onSelect={handleSelect} />
        {selected ? (
          <Reader
            message={selected}
            busy={busy}
            onTrash={() => handleTrash(selected.id)}
            onRestore={() => handleRestore(selected.id)}
          />
        ) : (
          <div className="card grid min-h-0 place-items-center p-6 text-sm text-faint">No message selected.</div>
        )}
        {selected ? <ContactCard message={selected} /> : <div className="card" />}
      </div>

      {composeOpen && <ComposeModal busy={busy} onClose={() => setComposeOpen(false)} onSubmit={handleCompose} />}
    </div>
  );
}

/* ---------------- Message list ---------------- */

function MessageList({
  list,
  selectedId,
  onSelect,
}: {
  list: Message[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="card flex min-h-0 flex-col overflow-hidden p-3">
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2">
        <Search className="h-4 w-4 text-faint" />
        <input placeholder="Search messages" className="field-bare" />
      </div>
      <div className="-mr-1 flex flex-1 flex-col gap-2 overflow-y-auto pr-1">
        {list.length === 0 && <p className="mt-8 text-center text-sm text-faint">No messages here.</p>}
        {list.map((m) => {
          const active = m.id === selectedId;
          const ch = CHANNEL[m.channel];
          const Icon = ch.icon;
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
                <div className="relative shrink-0">
                  <Avatar initials={m.initials} color={m.color} />
                  <span
                    className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full border-2"
                    style={{ background: ch.soft, borderColor: "var(--panel-solid)" }}
                  >
                    <Icon className="h-3 w-3" style={{ color: ch.color }} />
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-2 truncate text-sm font-semibold">
                      {m.name}
                      {m.unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />}
                    </p>
                    <span className="shrink-0 text-xs text-faint">{m.time}</span>
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

/* ---------------- Reader ---------------- */

function Reader({
  message,
  busy,
  onTrash,
  onRestore,
}: {
  message: Message;
  busy: boolean;
  onTrash: () => void;
  onRestore: () => void;
}) {
  return (
    <div className="card flex min-h-0 flex-col overflow-hidden p-6">
      <div className="flex items-center justify-between border-b border-[var(--border)] pb-4">
        <div className="flex items-center gap-3">
          <Avatar initials={message.initials} color={message.color} size="lg" />
          <div>
            <p className="text-base font-semibold">{message.name}</p>
            <p className="text-xs text-faint">
              {message.time} · {message.ago}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
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
          <button className="grid h-9 w-9 place-items-center rounded-full text-faint hover:text-[var(--text)]" aria-label="More">
            <MoreHorizontal className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-5">
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
              {message.attachments.map((a) => (
                <div
                  key={a.name}
                  className="flex items-center gap-3 rounded-2xl border border-[var(--border)] p-3 pr-5 transition-colors hover:border-[var(--border-strong)]"
                >
                  <FileIcon kind={a.kind} />
                  <div className="leading-tight">
                    <p className="text-sm font-medium">{a.name}</p>
                    <p className="text-xs text-faint">{a.size}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-[var(--border)] pt-4">
        <button className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold">
          <CornerUpLeft className="h-4 w-4" />
          Reply
        </button>
        <button className="btn-soft focus-ring flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium">
          <CornerUpRight className="h-4 w-4" />
          Forward
        </button>
      </div>
    </div>
  );
}

function FileIcon({ kind }: { kind: "pdf" | "doc" }) {
  const pdf = kind === "pdf";
  const color = pdf ? "var(--red)" : "var(--accent)";
  const soft = pdf ? "var(--red-soft)" : "var(--accent-soft)";
  return (
    <span className="grid h-11 w-11 place-items-center rounded-xl text-[10px] font-bold" style={{ background: soft, color }}>
      {pdf ? "PDF" : "DOC"}
    </span>
  );
}

/* ---------------- Contact card ---------------- */

function ContactCard({ message }: { message: Message }) {
  const actions = [
    { icon: Phone, label: "Call" },
    { icon: MessageCircle, label: "Text" },
    { icon: Mail, label: "Email" },
    { icon: DollarSign, label: "Revenue" },
    { icon: StickyNote, label: "Note" },
    { icon: MoreHorizontal, label: "More" },
  ];
  return (
    <div className="card flex min-h-0 flex-col overflow-y-auto p-5">
      <div className="flex items-start gap-3">
        <Avatar initials={message.initials} color={message.color} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-base font-semibold">
            <span className="truncate">{message.name}</span>
            <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--green)]" />
          </p>
          <p className="truncate text-xs text-faint">{message.role}</p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-6 gap-1">
        {actions.map((a) => {
          const Icon = a.icon;
          return (
            <button key={a.label} className="focus-ring group flex flex-col items-center gap-1">
              <span className="btn-soft grid h-9 w-9 place-items-center rounded-full transition-transform group-hover:-translate-y-0.5">
                <Icon className="h-4 w-4 text-accent" />
              </span>
              <span className="text-[10px] text-faint">{a.label}</span>
            </button>
          );
        })}
      </div>

      <p className="mt-6 mb-3 border-t border-[var(--border)] pt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        Contact Details
      </p>

      <Detail label="Email">
        <a href={`mailto:${message.email}`} className="text-accent hover:underline">
          {message.email}
        </a>
      </Detail>
      <Detail label="Phone">
        <a href={`tel:${message.phone}`} className="text-accent hover:underline">
          {message.phone}
        </a>
      </Detail>

      <Detail label="Location">
        <div className="mt-1 overflow-hidden rounded-xl border border-[var(--border)]">
          <div className="map-thumb grid h-24 place-items-center">
            <MapPin className="h-6 w-6 text-accent drop-shadow" fill="var(--accent)" />
          </div>
        </div>
        <a href="#" className="mt-2 inline-block text-accent hover:underline">
          Location Address
        </a>
      </Detail>

      <Detail label="Local Time">
        <span className="text-[var(--text)]">{message.localTime}</span>
      </Detail>

      <Detail label="Languages">
        <span className="text-[var(--text)]">{message.language}</span>
        <p className="mt-1 text-xs text-faint">Client prefers communication in {message.language}.</p>
      </Detail>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <InteractionCard dotColor="var(--green)" title="First Interaction" date={message.firstInteraction.date} time={message.firstInteraction.time} />
        <InteractionCard dotColor="var(--red)" title="Latest Interaction" date={message.latestInteraction.date} time={message.latestInteraction.time} />
      </div>
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

function InteractionCard({ dotColor, title, date, time }: { dotColor: string; title: string; date: string; time: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
        <span className="h-2 w-2 rounded-full" style={{ background: dotColor }} />
        {title}
      </p>
      <p className="mt-2 text-sm font-semibold">{date}</p>
      <p className="text-xs text-faint">{time}</p>
    </div>
  );
}

/* ---------------- Compose modal ---------------- */

function ComposeModal({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <form action={onSubmit} className="card relative z-10 w-full max-w-lg p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Send className="h-[18px] w-[18px] text-accent" /> New Email
          </h2>
          <button type="button" onClick={onClose} className="text-faint hover:text-[var(--text)]" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">
              To<span className="text-[var(--red)]"> *</span>
            </span>
            <input
              name="to"
              required
              autoFocus
              placeholder="Name or email address"
              className="field-input"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Subject</span>
            <input
              name="subject"
              placeholder="Subject line"
              className="field-input"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Message</span>
            <textarea
              name="body"
              rows={5}
              placeholder="Write your message..."
              className="field-input"
            />
          </label>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button type="button" onClick={onClose} className="btn-soft focus-ring rounded-xl px-5 py-2.5 text-sm font-medium">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-60">
            <Send className="h-4 w-4" /> {busy ? "Sending…" : "Send Email"}
          </button>
        </div>
      </form>
    </div>
  );
}
