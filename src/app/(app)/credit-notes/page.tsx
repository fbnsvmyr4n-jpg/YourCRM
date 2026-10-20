import { documentLedger, LEDGERS, nextDocumentNumber } from "@/server/document-ledger";
import { quotableProjects } from "@/server/repos/projects";
import { getSettings } from "@/server/repos/settings";
import { instantToWallClock } from "@/lib/zoned";
import { withTenantPage } from "@/server/tenant-session";
import { DocumentLedgerView } from "@/components/documents/DocumentLedgerView";

/* A credit note issued a minute ago must not still read as a draft. */
export const dynamic = "force-dynamic";

/**
 * Every credit note, across every job.
 *
 * The screen a credit note had nowhere to live without. Raising one is the
 * bookkeeper's work and lands on the invoices ledger, which finance can open —
 * and the document it produced was then only reachable from the job screen,
 * which `canAccessCrm` keeps them out of. So the role that raises a credit note
 * could not issue one: the same shape as the invoices ledger that did not
 * exist, and as the operations screen the notification bell pointed away from.
 */
export default async function CreditNotesPage() {
  const { ledger, projects, suggestedNumber, today } = await withTenantPage(
    async (q) => {
      const settings = await getSettings(q);
      return {
        ledger: await documentLedger(q, "credit_note"),
        projects: await quotableProjects(q),
        suggestedNumber: await nextDocumentNumber(q, "credit_note", LEDGERS.credit_note.prefix),
        today:
          instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
          new Date().toISOString().slice(0, 10),
      };
    },
    /* Money, so the money tier decides who may open it — the same door the
       invoices ledger uses, and the reason finance can reach both. */
    { money: true }
  );

  return (
    <DocumentLedgerView
      ledger={ledger}
      copy={LEDGERS.credit_note}
      projects={projects}
      suggestedNumber={suggestedNumber}
      today={today}
    />
  );
}
