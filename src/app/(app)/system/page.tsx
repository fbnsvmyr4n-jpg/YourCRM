import { jobLabel } from "@/data/jobs";
import { failingAutomations } from "@/server/repos/automations";
import { pendingCount, stuckWork } from "@/server/repos/outbox";
import { withTenantPage } from "@/server/tenant-session";
import { SystemHealthView } from "./SystemHealthView";

/* A job retried thirty seconds ago must not still read as failed. */
export const dynamic = "force-dynamic";

/**
 * Where an IT admin goes when the bell says something broke.
 *
 * It had nowhere. `canAccessOps` was read in exactly one place — whether to
 * fill the notification bell — so the role was told "1 quotation could not be
 * emailed" and handed a link to /chat, which their own tier redirects away
 * from. Every ops notification pointed at a page they cannot open.
 */
export default async function SystemHealthPage() {
  const { stuck, waiting, automations } = await withTenantPage(
    async (q) => ({
      stuck: await stuckWork(q),
      waiting: await pendingCount(q),
      /* The other half of the operational feed. The bell has always reported
         these to IT and pointed at the Automations section of Settings — which
         is `needsCrm: true`, because a rule acts on leads and deals. So that
         link was a wall as well, and this is the honest destination: the fact
         that a rule has stopped, without the rule itself. */
      automations: await failingAutomations(q),
    }),
    {
      /* The operations door: how the machine is running. Not customer records,
         not money, not mail — the fourth question, and the first screen to ask
         it. See `DOORS` in `tenant-session`. */
      ops: true,
    }
  );

  return (
    <SystemHealthView
      stuck={stuck.map((job) => ({
        id: job.id,
        /* Labelled HERE rather than in the component, so the screen never has
           to import anything that reaches the database. */
        label: jobLabel(job.handler),
        attempts: job.attempts,
        lastError: job.lastError,
        settledAt: job.settledAt,
        discardedAt: job.discardedAt,
      }))}
      waiting={waiting}
      automations={automations}
    />
  );
}
