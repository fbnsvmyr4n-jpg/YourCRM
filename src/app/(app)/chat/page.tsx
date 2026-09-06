import { listChat } from "@/server/repos/chat";
import { listContacts } from "@/server/repos/contacts";
import { listDeals } from "@/server/repos/deals";
import { listMeetings } from "@/server/repos/meetings";
import { aiConfigured } from "@/server/ai";
import { quotesNeedingUser } from "@/server/repos/quotes";
import { getSettings } from "@/server/repos/settings";
import { withTenantPage } from "@/server/tenant-session";
import { ChatView } from "./ChatView";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const { messages, knows, timeZone, quotes } = await withTenantPage(async (q) => ({
    messages: await listChat(q),
    /* A quotation waiting on somebody survives a reload, a different device and
       a different colleague. It is a decision the workspace owes a client, not
       a card that lives in one browser tab. */
    quotes: await quotesNeedingUser(q),
    /* Every bubble now carries the time it was sent, so the zone has to come
       from the business rather than the browser: formatting against the
       device's own zone would render one string on the server and a different
       one after hydration. */
    timeZone: (await getSettings(q)).timeZone,
    // Real counts, not decoration: the header claims the assistant knows the
    // user's data, and these are the receipts for that claim.
    knows: {
      contacts: (await listContacts(q)).length,
      deals: (await listDeals(q)).length,
      meetings: (await listMeetings(q)).length,
    },
  }));

  return (
    <ChatView
      messages={messages}
      /* The same function the agent and the health check ask, so the dot on
         this page cannot say "Online" while the assistant is actually falling
         back — an empty-string key reads as set to `process.env` and as absent
         to the API. */
      aiEnabled={aiConfigured()}
      knows={knows}
      timeZone={timeZone}
      quotes={quotes}
    />
  );
}
