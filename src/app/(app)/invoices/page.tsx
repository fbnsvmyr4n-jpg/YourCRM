import { documentLedger, LEDGERS, nextDocumentNumber } from "@/server/document-ledger";
import { quotableProjects } from "@/server/repos/projects";
import { getSettings } from "@/server/repos/settings";
import { instantToWallClock } from "@/lib/zoned";
import { withTenantPage } from "@/server/tenant-session";
import { DocumentLedgerView } from "@/components/documents/DocumentLedgerView";

/* An invoice marked paid a minute ago must not still read as outstanding. */
export const dynamic = "force-dynamic";

/**
 * Every invoice, across every job.
 *
 * The screen the finance role did not have. Invoices lived only inside a job,
 * and a job is customer work — which `canAccessCrm` keeps a bookkeeper out of
 * on purpose. So the person whose whole job is the money coming in could open
 * quotations and purchase orders and not one invoice, while `canSettleInvoice`
 * said they were the ones who may confirm a payment.
 */
export default async function InvoicesPage() {
  const { ledger, projects, suggestedNumber, today } = await withTenantPage(
    async (q) => {
      const settings = await getSettings(q);
      return {
        ledger: await documentLedger(q, "invoice"),
        projects: await quotableProjects(q),
        suggestedNumber: await nextDocumentNumber(q, "invoice", LEDGERS.invoice.prefix),
        /* The business's own day, so a payment entered at 01:00 in
           Johannesburg is not dated yesterday. */
        today:
          instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
          new Date().toISOString().slice(0, 10),
      };
    },
    {
      /* Money, so the money tier decides who may open it — which is what lets
         a bookkeeper work without handing them the pipeline. */
      money: true,
    }
  );

  return (
    <DocumentLedgerView
      ledger={ledger}
      copy={LEDGERS.invoice}
      projects={projects}
      suggestedNumber={suggestedNumber}
      today={today}
    />
  );
}
