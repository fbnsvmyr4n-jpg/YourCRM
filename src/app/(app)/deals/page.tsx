import { listDeals } from "@/server/deals-repo";
import { DealsBoard } from "./DealsBoard";

export const dynamic = "force-dynamic";

export default async function DealsPage() {
  const deals = await listDeals();
  return <DealsBoard deals={deals} />;
}
