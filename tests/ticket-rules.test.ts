import { describe, expect, it } from "vitest";
import { compareTickets, dueLabel, isOverdue, replyDueAt, shortDuration, type Ticket } from "../src/server/ticket-rules";

/** What a ticket owes and in what order the queue shows them — no database. */

const NOW = Date.parse("2026-09-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const t = (over: Partial<Ticket> = {}): Ticket => ({
  id: "tk",
  threadId: "th",
  status: "open",
  priority: "normal",
  assigneeUserId: null,
  awaitingSince: null,
  resolvedAt: null,
  createdAt: hoursAgo(100),
  ...over,
});

describe("what a ticket owes", () => {
  it("OWES NOTHING when nobody is waiting, or it is resolved", () => {
    expect(replyDueAt(t())).toBeNull();
    expect(replyDueAt(t({ status: "resolved", awaitingSince: hoursAgo(1) }))).toBeNull();
    expect(dueLabel(t(), NOW)).toBeNull();
  });

  it("times the reply from when the customer spoke, by priority", () => {
    expect(replyDueAt(t({ awaitingSince: hoursAgo(0), priority: "urgent" }))).toBe(NOW + 3_600_000);
    expect(replyDueAt(t({ awaitingSince: hoursAgo(0), priority: "low" }))).toBe(NOW + 72 * 3_600_000);
  });

  it("is overdue only once the time has passed — and changing priority re-times it", () => {
    const waited3h = t({ awaitingSince: hoursAgo(3) });
    expect(isOverdue(waited3h, NOW)).toBe(false);
    expect(isOverdue({ ...waited3h, priority: "urgent" }, NOW)).toBe(true);
    expect(dueLabel({ ...waited3h, priority: "urgent" }, NOW)).toBe("Reply overdue by 2h");
    expect(dueLabel(waited3h, NOW)).toBe("Reply within 21h");
  });

  it.each([
    [30 * 60_000, "30m"],
    [59 * 60_000, "59m"],
    [5 * 3_600_000, "5h"],
    [47 * 3_600_000, "47h"],
    [72 * 3_600_000, "3d"],
  ])("%d ms reads %s", (ms, text) => expect(shortDuration(ms)).toBe(text));
});

describe("the queue", () => {
  it("PUTS OVERDUE FIRST, then soonest due, then tickets waiting on the customer, then resolved", () => {
    const resolved = t({ id: "resolved", status: "resolved", resolvedAt: hoursAgo(1) });
    const waiting = t({ id: "waiting", status: "waiting" });
    const dueLater = t({ id: "due-later", awaitingSince: hoursAgo(1) });
    const overdue = t({ id: "overdue", awaitingSince: hoursAgo(2), priority: "urgent" });
    const sorted = [resolved, waiting, dueLater, overdue].sort(compareTickets).map((x) => x.id);
    expect(sorted).toEqual(["overdue", "due-later", "waiting", "resolved"]);
  });

  it("breaks a tie on priority, then newest", () => {
    const low = t({ id: "low", status: "waiting", priority: "low", createdAt: hoursAgo(1) });
    const high = t({ id: "high", status: "waiting", priority: "high", createdAt: hoursAgo(9) });
    const highNew = t({ id: "high-new", status: "waiting", priority: "high", createdAt: hoursAgo(2) });
    expect([low, high, highNew].sort(compareTickets).map((x) => x.id)).toEqual(["high-new", "high", "low"]);
  });
});
