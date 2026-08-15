import { listCalls } from "@/server/calls-repo";
import { telephonyStatus } from "@/server/telephony";
import { VoiceAgentConsole } from "./VoiceAgentConsole";

export const dynamic = "force-dynamic";

export default async function VoiceAgentsPage() {
  const calls = await listCalls();
  // Read at request time, not build time — the number can be connected by
  // setting an env var without redeploying the page.
  const { number } = telephonyStatus();
  return <VoiceAgentConsole calls={calls} phoneNumber={number} />;
}
