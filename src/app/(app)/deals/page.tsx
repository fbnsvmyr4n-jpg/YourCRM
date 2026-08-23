import { listDeals } from "@/server/repos/deals";
import { listContacts } from "@/server/repos/contacts";
import { withTenantPage } from "@/server/tenant-session";
import { decorateDeal } from "@/server/decorate-deal";
import { DealsBoard } from "./DealsBoard";

export const dynamic = "force-dynamic";

export default async function DealsPage() {
  // Deals and the people they belong to are read in one tenant transaction, so
  // a card cannot name a contact the same request would not return.
  const deals = await withTenantPage(async (q) => {
    const [rows, contacts] = [await listDeals(q), await listContacts(q)];
    const people = contacts.map((c) => ({
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      info: c.info,
    }));
    // Lost deals are excluded: a column of dead work sitting beside live work
    // is clutter that gets ignored. They stay counted in the reports.
    return rows.filter((d) => d.stage !== "lost").map((d) => decorateDeal(d, people));
  });

  return <DealsBoard deals={deals} />;
}
