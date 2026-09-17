import type { TenantQuery } from "./tenant";
import { businessToday } from "./repos/settings";
import { raiseDueRetainerInvoices } from "./repos/retainers";

/**
 * Raise whatever retainer invoices have fallen due, without ever breaking the
 * request that happened to do it.
 *
 * There is no scheduler until `CRON_SECRET` is set, so this runs wherever the
 * app is already open — the layout, for anybody who can see customer records —
 * and in the scheduled sweep once one exists. A failure is logged and rolled
 * back to a savepoint: a page must not fail to load because a bill could not be
 * drafted, and the next page load tries again.
 */
export async function raiseRetainersSafely(q: TenantQuery): Promise<number> {
  try {
    return await q.attempt(async () => (await raiseDueRetainerInvoices(q, await businessToday(q))).raised);
  } catch (err) {
    console.error("[retainers] could not raise due invoices; will retry on the next request:", err);
    return 0;
  }
}
