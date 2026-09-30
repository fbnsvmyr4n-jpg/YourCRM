import { notFound } from "next/navigation";
import { findDocument } from "@/server/repos/quotes";
import { getSettings } from "@/server/repos/settings";
import { findUserById } from "@/server/repos/users";
import { currentUser, withTenantPage } from "@/server/tenant-session";
import { withSystem } from "@/server/tenant";
import { DocumentSheet } from "./DocumentSheet";

/* A document somebody is about to put in front of a client must be what the
   database says right now, not what it said when the page was cached. */
export const dynamic = "force-dynamic";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await currentUser();

  const data = await withTenantPage(async (q) => {
    const document = await findDocument(q, id);
    /* `notFound()` rather than an empty sheet: either the row is not there or
       row-level security never showed it, and the two are indistinguishable from
       here on purpose. */
    if (!document) return null;
    const settings = await getSettings(q);
    return {
      document,
      ctx: q.ctx,
      currency: settings.currency,
      payTo: settings.invoicePayTo,
    };
  });

  if (!data) notFound();

  /*
     The workspace's own name and the approver's, in one system transaction that
     runs AFTER the tenant one has closed rather than inside it — a nested
     transaction needs two connections at once, and under a pool one deep that is
     a hang rather than an error.

     `agency_id` is on the workspace read because a system query carries no
     row-level security, so that filter is the only thing standing between a
     lookup by id and another customer's name.

     The approver is looked up by THE ID ON THE DOCUMENT, never from whoever is
     reading the page: the emailed copy names the person who said yes, and the
     printed copy a client files has to name the same one.
  */
  const who = await withSystem(async (sys) => {
    const row = await sys.one<{ name: string }>(
      `SELECT name FROM sub_accounts WHERE id = $2 AND agency_id = $1 AND deleted_at IS NULL`,
      [data.ctx.agencyId, data.ctx.subAccountId]
    );
    const approver = data.document.approvedByUserId
      ? await findUserById(sys, data.document.approvedByUserId)
      : null;
    return { business: row?.name ?? "", approvedBy: approver?.name ?? null };
  });

  return (
    <DocumentSheet
      doc={data.document}
      currency={data.currency}
      payTo={data.payTo}
      business={who.business}
      approvedBy={who.approvedBy}
      preparedBy={me?.name ?? null}
    />
  );
}
