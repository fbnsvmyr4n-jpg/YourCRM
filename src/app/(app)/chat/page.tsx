import { listChat } from "@/server/chat-repo";
import { ChatView } from "./ChatView";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const messages = await listChat();
  return <ChatView messages={messages} aiEnabled={!!process.env.ANTHROPIC_API_KEY} />;
}
