import { listMessages } from "@/server/inbox-repo";
import { InboxView } from "./InboxView";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const messages = await listMessages();
  return <InboxView messages={messages} />;
}
