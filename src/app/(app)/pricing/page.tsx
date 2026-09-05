import { listPriceItems } from "@/server/repos/pricing";
import { withTenantPage } from "@/server/tenant-session";
import { PricingView } from "./PricingView";

/* A price somebody corrected a minute ago must be the price the next quote is
   built from. A cached copy here is a quote going out at last week's rate. */
export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const items = await withTenantPage((q) => listPriceItems(q));
  return <PricingView items={items} />;
}
