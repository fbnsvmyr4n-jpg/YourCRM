import type { AvatarColor } from "@/components/ui/Avatar";
import { messages as seed, type Attachment, type Message } from "@/data/inbox";
import { classifyMessage } from "./inbox-classify";
import { mutateTable, readTable } from "./store";

const TABLE = "messages";

const COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

export type NewMessage = {
  to: string;
  subject: string;
  body: string;
  /** Carried over when replying or forwarding, so the thread keeps its files. */
  attachments?: Attachment[];
  /** Copied from the message being answered, so the panel keeps its context. */
  from?: Pick<Message, "name" | "role" | "company" | "phone" | "location" | "timeZone" | "initials" | "color">;
};

function initialsFor(name: string) {
  const parts = name.replace(/@.*/, "").split(/[\s.@]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "";
  const b = parts[1]?.[0] ?? "";
  return (a + b || name.trim().slice(0, 2)).toUpperCase();
}

/**
 * Fill in what a stored row can't have.
 *
 * `category` is classified here rather than at write time so messages that
 * predate the field still answer the chips — and so improving the rules
 * improves old mail too, instead of only what arrives next.
 *
 * `at` is backfilled for any row written before timestamps existed. Those rows
 * only ever had strings like "2m ago", so there is no real instant to recover;
 * they sort to the end rather than claiming a time they never had.
 */
function normalise(m: Message): Message {
  return {
    ...m,
    at: m.at ?? "",
    category: m.category ?? classifyMessage(m.subject, m.body ?? []),
  };
}

export async function listMessages(): Promise<Message[]> {
  const rows = await readTable<Message>(TABLE, seed);
  return rows.map(normalise).sort((a, b) => b.at.localeCompare(a.at));
}

export async function getMessage(id: string): Promise<Message | undefined> {
  const rows = await listMessages();
  return rows.find((m) => m.id === id);
}

export async function createMessage(input: NewMessage): Promise<Message> {
  let msg!: Message;

  await mutateTable<Message>(TABLE, seed, (rows) => {
    const to = input.to.trim() || "New Recipient";
    const body = input.body.trim();
    const subject = input.subject.trim() || "(no subject)";

    msg = {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      initials: input.from?.initials ?? initialsFor(to),
      color: input.from?.color ?? COLORS[rows.length % COLORS.length],
      name: input.from?.name ?? to,
      role: input.from?.role ?? "Recipient",
      company: input.from?.company ?? "—",
      subject,
      preview: body.slice(0, 120) || "—",
      at: new Date().toISOString(),
      category: classifyMessage(subject, body ? body.split(/\n\n+/) : []),
      unread: false,
      assigned: false,
      direction: "sent",
      trashed: false,
      body: body ? body.split(/\n\n+/) : ["(no content)"],
      attachments: input.attachments ?? [],
      email: /@/.test(to) ? to : "—",
      phone: input.from?.phone ?? "—",
      location: input.from?.location,
      timeZone: input.from?.timeZone,
      language: "English",
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
