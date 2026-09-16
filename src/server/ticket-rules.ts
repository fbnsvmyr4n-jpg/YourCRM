/**
 * Tickets without a database: what is owed, by when, and in what order.
 *
 * Shared by the Inbox, which draws the queue, and the server, which counts the
 * overdue ones for the bell — so "overdue" is one definition, not two.
 */

export const TICKET_STATUSES = ["open", "waiting", "resolved"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  waiting: "Waiting on customer",
  resolved: "Resolved",
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/**
 * How long a customer should wait for an answer, by priority. Clock hours,
 * not business hours — said on screen as "within 24 hours", which is what a
 * customer who wrote on Friday evening experiences.
 */
export const REPLY_HOURS: Record<TicketPriority, number> = {
  urgent: 1,
  high: 4,
  normal: 24,
  low: 72,
};

export type Ticket = {
  id: string;
  threadId: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigneeUserId: string | null;
  /** When the customer spoke and nobody has answered since. Null: nothing owed. */
  awaitingSince: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

const HOUR = 3_600_000;

export function isTicketStatus(v: unknown): v is TicketStatus {
  return (TICKET_STATUSES as readonly unknown[]).includes(v);
}

export function isTicketPriority(v: unknown): v is TicketPriority {
  return (TICKET_PRIORITIES as readonly unknown[]).includes(v);
}

/** When a reply is due, or null when none is owed. */
export function replyDueAt(t: Pick<Ticket, "status" | "priority" | "awaitingSince">): number | null {
  if (t.status === "resolved" || !t.awaitingSince) return null;
  const since = Date.parse(t.awaitingSince);
  return Number.isNaN(since) ? null : since + REPLY_HOURS[t.priority] * HOUR;
}

export function isOverdue(t: Pick<Ticket, "status" | "priority" | "awaitingSince">, now: number): boolean {
  const due = replyDueAt(t);
  return due !== null && due < now;
}

/** "45m", "5h", "3d" — rounded the way somebody glancing at a queue reads it. */
export function shortDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** What the ticket owes, in words: "Reply within 3h", "Reply overdue by 2h". */
export function dueLabel(t: Pick<Ticket, "status" | "priority" | "awaitingSince">, now: number): string | null {
  const due = replyDueAt(t);
  if (due === null) return null;
  return due < now ? `Reply overdue by ${shortDuration(now - due)}` : `Reply within ${shortDuration(due - now)}`;
}

const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_RANK: Record<TicketStatus, number> = { open: 0, waiting: 1, resolved: 2 };

/**
 * The queue: what needs doing first comes first.
 *
 * Unresolved before resolved; within them, owed replies before tickets waiting
 * on the customer, soonest-due first (so overdue leads); then priority; then
 * newest. Resolved ones are most recently resolved first.
 */
export function compareTickets(a: Ticket, b: Ticket): number {
  const aDone = a.status === "resolved";
  const bDone = b.status === "resolved";
  if (aDone !== bDone) return aDone ? 1 : -1;
  if (aDone && bDone) return (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "");

  const aDue = replyDueAt(a);
  const bDue = replyDueAt(b);
  if ((aDue === null) !== (bDue === null)) return aDue === null ? 1 : -1;
  if (aDue !== null && bDue !== null && aDue !== bDue) return aDue - bDue;

  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    b.createdAt.localeCompare(a.createdAt)
  );
}
