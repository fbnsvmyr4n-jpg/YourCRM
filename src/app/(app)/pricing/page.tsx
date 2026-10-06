import { listPriceItems } from "@/server/repos/pricing";
import { listSuppliers } from "@/server/repos/suppliers";
import { getMessage } from "@/server/repos/inbox";
import { getContact } from "@/server/repos/contacts";
import { findSupplierList } from "@/server/supplier-mail";
import { id as validId } from "@/server/validate";
import { withTenantPage } from "@/server/tenant-session";
import { PricingView } from "./PricingView";

/* A price somebody corrected a minute ago must be the price the next quote is
   built from. A cached copy here is a quote going out at last week's rate. */
export const dynamic = "force-dynamic";

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ fromMessage?: string }>;
}) {
  const { fromMessage } = await searchParams;

  const { items, suppliers, prefill } = await withTenantPage(async (q) => {
    const suppliers = await listSuppliers(q);

    /*
       Arriving from "Review and load it" on a message.

       The message's id travels, never the list — so the text is read back from
       the record here rather than taken from a URL. A link somebody edited, or
       one to a message in another workspace, simply finds nothing: `getMessage`
       is tenant-scoped, and the match is recomputed from scratch against this
       workspace's own suppliers. Prices cannot be smuggled in through a link.
    */
    const messageId = validId(fromMessage);
    const message = messageId ? await getMessage(q, messageId) : null;
    /* The message carries a contact, not an address — the inbox resolves the
       sender through the contact record and so does this, so both sides are
       matching the same fact. */
    const sender = message?.contactId ? await getContact(q, message.contactId) : null;
    const found =
      message && sender
        ? findSupplierList(
            {
              direction: message.direction,
              email: sender.email ?? "",
              subject: message.subject,
              body: message.body.split(/\r?\n/),
            },
            suppliers
          )
        : null;

    return {
      items: await listPriceItems(q),
      suppliers,
      prefill: found ? { supplierId: found.supplierId, text: found.text } : null,
    };
  }, {
    /*
       MONEY, not customer records.

       There is not one customer fact on this screen: it is what the business
       charges and what its suppliers charge. Gating it on customer data kept
       the finance role out of the one list they need most — reconciling a
       supplier's invoice against the rate that supplier agreed is the job, and
       without this they are checking an invoice against nothing.

       IT is still refused, which is right: what the business charges is not
       part of fixing the machine.
    */
    money: true,
  });

  return <PricingView items={items} suppliers={suppliers} prefill={prefill} />;
}
