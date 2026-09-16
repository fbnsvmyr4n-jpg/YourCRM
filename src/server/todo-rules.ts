/**
 * What a task is, with no database and no clock of its own.
 *
 * "Today" is always passed IN, as the business's own calendar day. A task is
 * due on a day in Johannesburg or Auckland, and asking the machine running this
 * what day it is gives the answer for wherever that machine happens to be. The
 * server works out the business's day once, from its time zone, and everything
 * here compares against that.
 *
 * Plain functions and no imports, so the screens use exactly the same rules as
 * the server — a task the page calls overdue is the one the bell counts.
 */

export const MAX_TITLE = 200;
export const MAX_NOTES = 2000;

export type Todo = {
  id: string;
  title: string;
  notes: string | null;
  /** YYYY-MM-DD in the business's calendar, or null for "no particular day". */
  dueOn: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  contactId: string | null;
  contactName: string | null;
  dealId: string | null;
  dealTitle: string | null;
  doneAt: string | null;
  /** Null when a rule created it. */
  createdByUserId: string | null;
  automationId: string | null;
  createdAt: string;
};

export type Bucket = "overdue" | "today" | "upcoming" | "undated" | "done";

export const BUCKET_ORDER: readonly Bucket[] = ["overdue", "today", "upcoming", "undated", "done"];

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function bucketOf(todo: Pick<Todo, "dueOn" | "doneAt">, today: string): Bucket {
  if (todo.doneAt) return "done";
  if (!todo.dueOn) return "undated";
  const diff = daysBetween(today, todo.dueOn);
  return diff < 0 ? "overdue" : diff === 0 ? "today" : "upcoming";
}

/**
 * Open tasks in the order somebody should do them: the longest overdue first,
 * then by day, then undated ones in the order they were added. Done ones, most
 * recently finished first.
 */
export function sortTodos<T extends Pick<Todo, "dueOn" | "doneAt" | "createdAt">>(todos: T[]): T[] {
  return [...todos].sort((a, b) => {
    if (a.doneAt || b.doneAt) {
      if (a.doneAt && b.doneAt) return b.doneAt.localeCompare(a.doneAt);
      return a.doneAt ? 1 : -1;
    }
    if (a.dueOn && b.dueOn && a.dueOn !== b.dueOn) return a.dueOn.localeCompare(b.dueOn);
    if (a.dueOn !== b.dueOn) return a.dueOn ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * When a task is due, said the way a person says it.
 *
 * Near days by name — Today, Tomorrow, Yesterday — because that is what people
 * scan for; the coming week by weekday; anything further by date. Overdue says
 * by how much, because "due 3 Sep" does not tell you it is two weeks late.
 * Formatted by hand so the server and the browser print the same string.
 */
export function dueLabel(dueOn: string | null, today: string): string {
  if (!dueOn) return "No due date";
  const diff = daysBetween(today, dueOn);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff < -1) return `${-diff} days overdue`;
  const [y, m, d] = dueOn.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  if (diff < 7) return weekday;
  const sameYear = dueOn.slice(0, 4) === today.slice(0, 4);
  return `${weekday} ${d} ${MONTHS[m - 1]}${sameYear ? "" : ` ${y}`}`;
}
