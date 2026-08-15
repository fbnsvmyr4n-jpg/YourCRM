import { listChat } from "@/server/chat-repo";
import { listContacts } from "@/server/contacts-repo";
import { listDeals } from "@/server/deals-repo";
import { listMeetings } from "@/server/meetings-repo";
import { ChatView } from "./ChatView";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const [messages, contacts, deals, meetings] = await Promise.all([
    listChat(),
    listContacts(),
    listDeals(),
    listMeetings(),
  ]);

  return (
    <ChatView
      messages={messages}
      aiEnabled={!!process.env.ANTHROPIC_API_KEY}
      // Real counts, not decoration: the header claims the assistant knows the
      // user's data, and these are the receipts for that claim.
      knows={{ contacts: contacts.length, deals: deals.length, meetings: meetings.length }}
    />
  );
}
