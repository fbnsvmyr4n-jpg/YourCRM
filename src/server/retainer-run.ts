import type { TenantQuery } from "./tenant";
import { businessToday } from "./repos/settings";
import { raiseDueRetainerInvoices } from "./repos/retainers";
import { chaseOverdueInvoices } from "./repos/payments";

/**
 * The billing housekeeping that has to happen on its date: retainer invoices
 * that fell due, and a task to chase each invoice that went past its due date
 * unpaid — without ever breaking the request that happened to do it.
 *
 * There is no scheduler until `CRON_SECRET` is set, so this runs wherever the
 * app is already open — the layout, for anybody who can see customer records —
 * and in the scheduled sweep once one exists. Each part runs in its own
 * savepoint: a failure is logged and rolled back, the page still loads, and the
 * next request tries again.
 */
export async function raiseRetainersSafely(q: TenantQuery): Promise<number> {
  let raised = 0;
  let today: string;
  try {
    today = await q.attempt(() => businessToday(q));
  } catch (err) {
    console.error("[billing-run] could not read the business day; will retry on the next request:", err);
    return 0;
  }
  try {
    raised = await q.attempt(async () => (await raiseDueRetainerInvoices(q, today)).raised);
  } catch (err) {
    console.error("[retainers] could not raise due invoices; will retry on the next request:", err);
  }
  try {
    await q.attempt(() => chaseOverdueInvoices(q, today));
  } catch (err) {
    console.error("[invoices] could not raise overdue reminders; will retry on the next request:", err);
  }
  return raised;
}
