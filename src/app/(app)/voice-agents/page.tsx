import { listCalls } from "@/server/repos/calls";
import { listContacts } from "@/server/repos/contacts";
import { getSettings } from "@/server/repos/settings";
import { decorateCall } from "@/server/decorate-call";
import { telephonyStatus } from "@/server/telephony";
import { withCurrentTenant } from "@/server/tenant-session";
import { VoiceAgentConsole } from "./VoiceAgentConsole";

export const dynamic = "force-dynamic";

export default async function VoiceAgentsPage() {
  const calls = await withCurrentTenant(async (q) => {
    const settings = await getSettings(q);
    const rows = await listCalls(q);
    const contacts = await listContacts(q);
    const people = contacts.map((c) => ({
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      info: c.info,
    }));
    return rows.map((c) => decorateCall(c, people, settings.timeZone));
  });

  // Read at request time, not build time — the number can be connected by
  // setting an env var without redeploying the page.
  const { number } = telephonyStatus();
  return <VoiceAgentConsole calls={calls} phoneNumber={number} />;
}
