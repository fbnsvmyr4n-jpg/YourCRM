import { mutateTable, readTable, writeTable } from "./store";

const TABLE = "chat";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
};

const seed: ChatMessage[] = [
  {
    id: "chat-welcome",
    role: "assistant",
    text: "Hi Lang 👋 I'm your CRM assistant. I can see your live pipeline, contacts, leads and meetings — ask me things like “what's my pipeline worth?”, “who should I follow up with?”, or “what's on today?”",
    at: new Date("2026-07-26T08:00:00.000Z").toISOString(),
  },
];

export async function listChat(): Promise<ChatMessage[]> {
  return readTable<ChatMessage>(TABLE, seed);
}

export async function appendChat(
  role: ChatMessage["role"],
  text: string
): Promise<ChatMessage> {
  let msg!: ChatMessage;
  await mutateTable<ChatMessage>(TABLE, seed, (rows) => {
    msg = {
      id: `msg-${Math.random().toString(36).slice(2, 10)}`,
      role,
      text,
      at: new Date().toISOString(),
    };
    return [...rows, msg];
  });
  return msg;
}

export async function clearChat(): Promise<void> {
  await writeTable(TABLE, seed);
}
