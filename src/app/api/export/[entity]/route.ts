import { listCompanies } from "@/server/repos/companies";
import { listContacts } from "@/server/repos/contacts";
import { listDeals } from "@/server/repos/deals";
import { listMeetings } from "@/server/repos/meetings";
import { toCsv } from "@/server/csv";
import { requireTenant, withCurrentTenant } from "@/server/tenant-session";

/**
 * Take your data with you.
 *
 * The product could import contacts and never hand anything back, which makes
 * a CRM a place data goes into. Somebody evaluating this asks the question
 * early and an honest answer is a feature; somebody leaving asks it too, and
 * refusing then is how a product earns a bad reputation on the way out.
 *
 * A route handler rather than a server action, because this is a file the
 * browser saves. An action returns a value into React, and turning that into a
 * download means building a blob in the client from data that already crossed
 * the wire once.
 *
 * Authorisation is two things and neither is a parameter. `requireTenant`
 * settles whether there is a session at all; `withCurrentTenant` scopes every
 * query underneath to that session's sub-account through row level security.
 * The URL carries nothing but a table name, so there is no "which agency" for a
 * caller to edit.
 */

export const dynamic = "force-dynamic";

const ENTITIES = ["contacts", "deals", "meetings", "companies"] as const;
type Entity = (typeof ENTITIES)[number];

function isEntity(value: string): value is Entity {
  return (ENTITIES as readonly string[]).includes(value);
}

/** Cents to a plain decimal, so a spreadsheet reads it as money and not as 500000. */
const amount = (cents: number) => (cents / 100).toFixed(2);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ entity: string }> }
) {
  /*
     Signed in first, and answered as 401 rather than left to throw.

     Without this the route still refuses — `withCurrentTenant` throws, and the
     body that came back was empty — but it does so as a 500, which says "this
     server is broken" to a caller whose actual problem is an expired session,
     and files a real error in the log for something that is not one.
  */
  try {
    await requireTenant();
  } catch {
    return new Response("Not authenticated.", { status: 401 });
  }

  const { entity } = await params;
  if (!isEntity(entity)) {
    return new Response("Not found", { status: 404 });
  }

  const csv = await withCurrentTenant(async (q) => {
    switch (entity) {
      case "contacts": {
        const rows = await listContacts(q);
        return toCsv(
          ["First name", "Last name", "Email", "Phone", "Company", "Location", "Client", "Open deal", "Added"],
          rows.map((c) => [
            c.firstName,
            c.lastName,
            c.email ?? "",
            c.phone ?? "",
            c.companyName ?? "",
            c.location ?? "",
            c.isClient ? "yes" : "no",
            c.hasOpenDeal ? "yes" : "no",
            c.createdAt,
          ])
        );
      }
      case "deals": {
        const [deals, contacts] = [await listDeals(q), await listContacts(q)];
        // Joined here rather than in SQL: the export is for a person reading a
        // spreadsheet, and a column of `ct-a1b2` ids helps nobody.
        const nameOf = new Map(
          contacts.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()])
        );
        return toCsv(
          ["Title", "Contact", "Value", "Stage", "Source", "Lost reason", "Won at", "Created"],
          deals.map((d) => [
            d.title,
            d.contactId ? nameOf.get(d.contactId) ?? "" : "",
            amount(d.valueCents),
            d.stage,
            d.source,
            d.lostReason ?? "",
            d.wonAt ?? "",
            d.createdAt,
          ])
        );
      }
      case "meetings": {
        const [meetings, contacts] = [await listMeetings(q), await listContacts(q)];
        const nameOf = new Map(
          contacts.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()])
        );
        return toCsv(
          ["Topic", "Contact", "Scheduled at", "Minutes", "Kind", "Outcome", "Loss reason", "Notes"],
          meetings.map((m) => [
            m.topic,
            m.contactId ? nameOf.get(m.contactId) ?? "" : "",
            m.scheduledAt,
            String(m.durationMin),
            m.kind,
            m.outcome,
            m.lossReason ?? "",
            m.notes ?? "",
          ])
        );
      }
      case "companies": {
        const rows = await listCompanies(q);
        return toCsv(
          ["Name", "Domain", "Notes"],
          rows.map((c) => [c.name, c.domain ?? "", c.info ?? ""])
        );
      }
    }
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="yourcrm-${entity}-${stamp}.csv"`,
      // A customer's own records, in a file. Nothing between here and them
      // should keep a copy.
      "Cache-Control": "no-store, private",
    },
  });
}
