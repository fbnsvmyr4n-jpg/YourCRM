import { listChat } from "@/server/repos/chat";
import { listContacts } from "@/server/repos/contacts";
import { listDeals } from "@/server/repos/deals";
import { listMeetings } from "@/server/repos/meetings";
import { withTenantPage } from "@/server/tenant-session";
import { ChatView } from "./ChatView";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const { messages, knows } = await withTenantPage(async (q) => ({
    messages: await listChat(q),
    // Real counts, not decoration: the header claims the assistant knows the
    // user's data, and these are the receipts for that claim.
    knows: {
      contacts: (await listContacts(q)).length,
      deals: (await listDeals(q)).length,
      meetings: (await listMeetings(q)).length,
    },
  }));

  return (
    <ChatView messages={messages} aiEnabled={!!process.env.ANTHROPIC_API_KEY} knows={knows} />
  );
}
