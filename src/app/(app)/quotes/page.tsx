import { documentLedger, LEDGERS, nextDocumentNumber } from "@/server/document-ledger";
import { quotableProjects } from "@/server/repos/projects";
import { getSettings } from "@/server/repos/settings";
import { instantToWallClock } from "@/lib/zoned";
import { withTenantPage } from "@/server/tenant-session";
import { DocumentLedgerView } from "@/components/documents/DocumentLedgerView";

/* A quotation raised a minute ago must be in this list. A cached copy is
   somebody re-raising one that already exists. */
export const dynamic = "force-dynamic";

export default async function QuotesPage() {
  const { ledger, projects, suggestedNumber, today } = await withTenantPage(async (q) => {
    const settings = await getSettings(q);
    return {
      ledger: await documentLedger(q, "quote"),
      projects: await quotableProjects(q),
      suggestedNumber: await nextDocumentNumber(q, "quote", LEDGERS.quote.prefix),
      /* The business's own day, not the server's — the same rule the rest of
         the product follows, so a quotation raised at 01:00 in Johannesburg is
         not dated yesterday. */
      today:
        instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
        new Date().toISOString().slice(0, 10),
    };
  }, {
    /* A money document, so the MONEY tier decides who may open it — which is
       what lets a bookkeeper work without handing them the pipeline. See
       `canAccessMoney`. */
    money: true,
  });

  return (
    <DocumentLedgerView
      ledger={ledger}
      copy={LEDGERS.quote}
      projects={projects}
      suggestedNumber={suggestedNumber}
      today={today}
    />
  );
}
