"use client";

import { useState } from "react";
import { Ticket as TicketIcon } from "lucide-react";
import { useNow } from "@/components/ui/TimeAgo";
import { clsx } from "@/lib/clsx";
import {
  dueLabel,
  isOverdue,
  PRIORITY_LABEL,
  STATUS_LABEL,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from "@/server/ticket-rules";
import { trackTicketAction, updateTicketAction } from "@/app/(app)/inbox/actions";

/**
 * A conversation as a ticket: the bar in the reader, the line in the queue,
 * and the button that starts tracking one.
 *
 * Nothing here keeps its own copy. Each change revalidates the page and the
 * ticket comes back down as a prop, so the queue, the bar and the bell agree.
 */

export const STATUS_TONE: Record<TicketStatus, { color: string; soft: string }> = {
  open: { color: "var(--accent)", soft: "var(--accent-soft)" },
  waiting: { color: "var(--amber)", soft: "var(--amber-soft)" },
  resolved: { color: "var(--green)", soft: "var(--green-soft)" },
};

const PRIORITY_TONE: Record<TicketPriority, string> = {
  urgent: "var(--red)",
  high: "var(--amber)",
  normal: "var(--text-muted)",
  low: "var(--text-faint)",
};

/** Selects render their own font; an inline size is the one thing that wins. */
const SELECT_STYLE = { fontSize: 12, lineHeight: "16px" } as const;
const selectClass =
  "focus-ring min-w-0 max-w-full truncate rounded-md border border-[var(--border)] bg-transparent px-1.5 py-1 font-medium disabled:opacity-60";

/** "Reply overdue by 2h" in red, "Reply within 5h" quietly — nothing when nothing is owed. */
export function DueText({ ticket, className }: { ticket: Ticket; className?: string }) {
  const now = useNow();
  if (now === null) return null;
  const label = dueLabel(ticket, now);
  if (!label) return null;
  return (
    <span
      className={clsx("whitespace-nowrap text-xs font-medium", className)}
      style={{ color: isOverdue(ticket, now) ? "var(--red)" : "var(--text-faint)" }}
    >
      {label}
    </span>
  );
}

/** The one line a ticket gets in the queue. */
export function TicketLine({ ticket, assignee }: { ticket: Ticket; assignee: string | null }) {
  const tone = STATUS_TONE[ticket.status];
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: tone.soft, color: tone.color }}>
        {ticket.status === "waiting" ? "WAITING" : STATUS_LABEL[ticket.status].toUpperCase()}
      </span>
      {ticket.priority !== "normal" && (
        <span className="text-[11px] font-semibold" style={{ color: PRIORITY_TONE[ticket.priority] }}>
          {PRIORITY_LABEL[ticket.priority]}
        </span>
      )}
      <span className="min-w-0 truncate text-[11px] text-faint">{assignee ?? "Unassigned"}</span>
      <DueText ticket={ticket} className="ml-auto text-[11px]" />
    </div>
  );
}

/** Status, priority and owner, where the conversation is read. */
export function TicketBar({
  ticket,
  team,
  currentUserId,
}: {
  ticket: Ticket;
  team: { id: string; name: string }[];
  currentUserId: string | null;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(patch: { status?: string; priority?: string; assigneeUserId?: string | null }) {
    setSaving(true);
    setError(null);
    try {
      const out = await updateTicketAction(ticket.id, patch);
      if ("error" in out) setError(out.error);
    } finally {
      setSaving(false);
    }
  }

  const tone = STATUS_TONE[ticket.status];
  /* Somebody no longer on the team still shows by name rather than vanishing
     into "Unassigned", which would be a different, untrue statement. */
  const inTeam = !ticket.assigneeUserId || team.some((p) => p.id === ticket.assigneeUserId);

  return (
    <div className="mb-4 rounded-xl border border-[var(--border)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <TicketIcon className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
        <select
          aria-label="Ticket status"
          value={ticket.status}
          disabled={saving}
          onChange={(e) => void change({ status: e.target.value })}
          className={selectClass}
          style={{ ...SELECT_STYLE, background: tone.soft, color: tone.color, borderColor: "transparent" }}
        >
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="Priority"
          value={ticket.priority}
          disabled={saving}
          onChange={(e) => void change({ priority: e.target.value })}
          className={selectClass}
          style={{ ...SELECT_STYLE, color: PRIORITY_TONE[ticket.priority] }}
        >
          {TICKET_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]} priority
            </option>
          ))}
        </select>
        <select
          aria-label="Assigned to"
          value={ticket.assigneeUserId ?? ""}
          disabled={saving}
          onChange={(e) => void change({ assigneeUserId: e.target.value || null })}
          className={selectClass}
          style={SELECT_STYLE}
        >
          <option value="">Unassigned</option>
          {!inTeam && <option value={ticket.assigneeUserId ?? ""}>No longer on the team</option>}
          {team.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === currentUserId ? `${p.name} (me)` : p.name}
            </option>
          ))}
        </select>
        <DueText ticket={ticket} className="ml-auto" />
      </div>
      {error && (
        <p className="mt-2 text-xs" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

/** Start tracking this conversation. */
export function TrackTicketButton({ threadId }: { threadId: string }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          setError(null);
          try {
            const out = await trackTicketAction(threadId);
            if ("error" in out) setError(out.error);
          } finally {
            setSaving(false);
          }
        }}
        title="Track this conversation as a ticket: a status, an owner and a reply-by time"
        className="btn-soft focus-ring ml-auto flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium disabled:opacity-60"
      >
        <TicketIcon className="h-4 w-4" />
        {saving ? "Tracking…" : "Track as ticket"}
      </button>
      {error && (
        <span className="text-xs" style={{ color: "var(--red)" }}>
          {error}
        </span>
      )}
    </>
  );
}
