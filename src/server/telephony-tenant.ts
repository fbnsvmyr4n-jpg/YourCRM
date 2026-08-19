import { logDenied } from "./log";
import { withSystem, type TenantContext } from "./tenant";

/**
 * Which customer an inbound call belongs to.
 *
 * A telephony webhook carries no session — it is Twilio talking to a public
 * URL — so nothing about the request says whose CRM the call should land in.
 * The dialled number is the only thing that does.
 *
 * Resolution, in order, and each step is deliberate:
 *
 *  1. A sub-account claiming that number. Unambiguous, because the column is
 *     unique.
 *  2. If nothing claims it AND the platform has exactly one sub-account, that
 *     one. This keeps a single-customer deployment working without anybody
 *     having to configure a number they only have one of — but it is logged,
 *     because it is an inference rather than a fact.
 *  3. Otherwise nothing. Refusing is the only safe answer: writing a caller's
 *     details into whichever account happened to sort first is a cross-tenant
 *     leak that arrives as somebody else's customer appearing in your CRM.
 */
export async function tenantForDialledNumber(to: string | null): Promise<TenantContext | null> {
  return withSystem(async (q) => {
    const digits = (s: string) => s.replace(/\D/g, "");
    const wanted = digits(to ?? "");

    if (wanted) {
      const row = await q.one<{ id: string; agency_id: string }>(
        // Compared on digits so "+27 21 000 0000" and "+27210000000" match, the
        // same normalisation the caller matching uses.
        `SELECT id, agency_id FROM sub_accounts
         WHERE regexp_replace(COALESCE(phone_number, ''), '\\D', '', 'g') = $1
           AND deleted_at IS NULL`,
        [wanted]
      );
      if (row) {
        return { agencyId: row.agency_id, subAccountId: row.id, userId: "", role: "owner" as const };
      }
    }

    const only = await q.rows<{ id: string; agency_id: string }>(
      `SELECT id, agency_id FROM sub_accounts WHERE deleted_at IS NULL LIMIT 2`
    );
    if (only.length === 1) {
      logDenied("telephony", "no sub-account claims this number; inferred the only one");
      return {
        agencyId: only[0].agency_id,
        subAccountId: only[0].id,
        userId: "",
        role: "owner" as const,
      };
    }

    logDenied("telephony", "no sub-account claims this number and more than one exists");
    return null;
  });
}
