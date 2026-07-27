import type { AvatarColor } from "@/components/ui/Avatar";
import { messages as seed, type Message } from "@/data/inbox";
import { mutateTable, readTable } from "./store";

const TABLE = "messages";

const COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

export type NewMessage = { to: string; subject: string; body: string };

function initialsFor(name: string) {
  const parts = name.replace(/@.*/, "").split(/[\s.@]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "";
  const b = parts[1]?.[0] ?? "";
  return (a + b || name.trim().slice(0, 2)).toUpperCase();
}

export async function listMessages(): Promise<Message[]> {
  return readTable<Message>(TABLE, seed);
}

export async function createMessage(input: NewMessage): Promise<Message> {
  let msg!: Message;
  await mutateTable<Message>(TABLE, seed, (rows) => {
    const to = input.to.trim() || "New Recipient";
    const body = input.body.trim();
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    msg = {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      initials: initialsFor(to),
      color: COLORS[rows.length % COLORS.length],
      name: to,
      role: "Recipient",
      company: "—",
      subject: input.subject.trim() || "(no subject)",
      preview: body.slice(0, 120) || "—",
      time: "Just now",
      ago: "just now",
      channel: "blue",
      unread: false,
      assigned: false,
      direction: "sent",
      trashed: false,
      body: body ? body.split(/\n\n+/) : ["(no content)"],
      attachments: [],
      email: /@/.test(to) ? to : "—",
      phone: "—",
      localTime: `${dateStr}, ${timeStr}`,
      language: "English",
      firstInteraction: { date: dateStr, time: timeStr },
      latestInteraction: { date: dateStr, time: timeStr },
    };
    return [msg, ...rows];
  });
  return msg;
}

async function patch(id: string, fn: (m: Message) => Message): Promise<void> {
  await mutateTable<Message>(TABLE, seed, (rows) => {
    const idx = rows.findIndex((m) => m.id === id);
    if (idx === -1) return rows;
    const next = [...rows];
    next[idx] = fn(next[idx]);
    return next;
  });
}

export async function markRead(id: string): Promise<void> {
  await patch(id, (m) => ({ ...m, unread: false }));
}

export async function trashMessage(id: string): Promise<void> {
  await patch(id, (m) => ({ ...m, trashed: true }));
}

export async function restoreMessage(id: string): Promise<void> {
  await patch(id, (m) => ({ ...m, trashed: false }));
}
