import { listCalls } from "@/server/calls-repo";
import { VoiceAgentConsole } from "./VoiceAgentConsole";

export const dynamic = "force-dynamic";

export default async function VoiceAgentsPage() {
  const calls = await listCalls();
  return <VoiceAgentConsole calls={calls} />;
}
