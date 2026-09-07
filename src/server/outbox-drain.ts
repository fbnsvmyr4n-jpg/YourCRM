import { withSystem, type TenantContext } from "./tenant";
import { drain, type DrainReport } from "./outbox";
import { OUTBOX_REGISTRY } from "./outbox-handlers";

/**
 * The sweep that catches what a request could not finish.
 *
 * Almost every job is run by the request that queued it, moments later. This
 * exists for the rest: the send that failed while the provider was restarting,
 * the analysis whose request was frozen, the workspace whose email was
 * switched on this afternoon. Without it, `run_after` is a promise nothing
 * keeps — a retry ladder with nothing standing on it.
 *
 * ── Why this module reads every workspace ────────────────────────────────
 *
 * Row-level security is FORCED on `outbox`, which is right and stays. The
 * consequence is that no single query can see across workspaces: a sweep has
 * to know which workspaces exist and then enter each one properly scoped.
 *
 * So this is the one module that lists `sub_accounts` without an agency
 * filter, and its exemption rests on two properties the suite checks rather
 * than trusts:
 *
 *   - it selects **ids only** — never a name, a number, or anything a person
 *     could read — so nothing here can leak one customer's details to another;
 *   - every row it then touches is reached through `withTenant`, under the
 *     same policies as any screen.
 *
 * If either goes, the exemption goes with it.
 *
 * A workspace at a time, in order, is deliberately unclever. This runs on a
 * schedule against a handful of workspaces; when that stops being true the
 * answer is a table recording which workspaces have work — not a faster query
 * here, which would still have to visit them all.
 */

export type SweepReport = DrainReport & { workspaces: number };

/**
 * Drain up to `perWorkspace` jobs for every workspace.
 *
 * One workspace failing must not strand the others: an exception here is
 * almost always something about that workspace — a handler throwing on its
 * data, a lock — and stopping the sweep would let one bad job hold up the
 * whole platform's mail.
 */
export async function sweep(perWorkspace = 10): Promise<SweepReport> {
  const workspaces = await withSystem((sys) =>
    sys.rows<{ id: string; agency_id: string }>(
      // Ids only. Nothing readable is selected, which is the property this
      // module's exemption from agency filtering rests on.
      `SELECT id, agency_id FROM sub_accounts WHERE deleted_at IS NULL ORDER BY created_at ASC`
    )
  );

  const total: SweepReport = { workspaces: 0, ran: 0, done: 0, retried: 0, dead: 0 };
  for (const row of workspaces) {
    /*
       The sweep acts as the workspace itself rather than as a person.

       There is no user pressing anything — this is a scheduled invocation —
       so `userId` is empty and the role is the one a workspace's own
       automation gets. Nothing here is authorised by that role: the handlers
       act on jobs a person already authorised when they queued them.
    */
    const ctx: TenantContext = {
      agencyId: row.agency_id,
      subAccountId: row.id,
      userId: "",
      role: "owner",
    };
    try {
      const report = await drain(ctx, OUTBOX_REGISTRY, perWorkspace);
      total.workspaces += 1;
      total.ran += report.ran;
      total.done += report.done;
      total.retried += report.retried;
      total.dead += report.dead;
    } catch (err) {
      console.error(`[outbox] sweep failed for one workspace; continuing:`, err);
    }
  }

  /*
     Said loudly, because a dead job is the one outcome nobody is told about.

     Everything else in this system reports itself: a failed send shows on the
     screen that asked for it, a retry is invisible by design. A job that has
     been given up on is only a row, and the person who needed the email has no
     reason to go looking. Until there is somewhere in the app to see these,
     this line in the deployment log is where it surfaces — no ids, no
     addresses, just how many and for whom.
  */
  if (total.dead > 0) {
    console.error(
      `[outbox] ${total.dead} job(s) were given up on across ${total.workspaces} workspace(s) — somebody needs to look`
    );
  }
  return total;
}
