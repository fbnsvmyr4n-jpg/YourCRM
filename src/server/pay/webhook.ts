import { withSystem, withTenant, type TenantContext } from "../tenant";
import { paystackSecret, recordDispute, recordPaystackPayment } from "../repos/payments";
import { businessToday, getSettings } from "../repos/settings";
import { signatureMatches, verifyTransaction } from "../paystack";
import { id as validId } from "../validate";

/**
 * A webhook from ONE workspace's Paystack account.
 *
 * The URL says which workspace; the signature proves it — it is checked with
 * that workspace's own secret key, so a body signed by any other account,
 * YourCRM's included, is refused. A signed `charge.success` is still verified
 * with Paystack before money is recorded: the webhook is a prompt to look, not
 * the record itself.
 *
 * Status codes follow what makes a retry useful. 200 for anything decided,
 * including events deliberately ignored; 401 for a bad signature; 500 only when
 * we could not decide (database or Paystack unreachable), which Paystack retries.
 */
export type WebhookResult = { status: number; body: Record<string, unknown> };

export async function handlePaystackWebhook(
  agencyIdRaw: string,
  subAccountIdRaw: string,
  rawBody: string,
  signature: string | null,
  f: typeof fetch = fetch
): Promise<WebhookResult> {
  const agencyId = validId(agencyIdRaw);
  const subAccountId = validId(subAccountIdRaw);
  if (!agencyId || !subAccountId) return { status: 404, body: { error: "unknown workspace" } };

  const workspace = await withSystem((sys) =>
    sys.one<{ id: string }>(
      `SELECT id FROM sub_accounts WHERE id = $2 AND agency_id = $1 AND deleted_at IS NULL`,
      [agencyId, subAccountId]
    )
  );
  /* Unknown workspace and wrong signature look the same from outside. */
  if (!workspace) return { status: 401, body: { error: "invalid signature" } };

  const ctx: TenantContext = { agencyId, subAccountId, userId: "", role: "owner" };
  return withTenant(ctx, async (q) => {
    const secret = await paystackSecret(q);
    if (!secret || !signatureMatches(rawBody, signature, secret)) {
      return { status: 401, body: { error: "invalid signature" } };
    }

    let event: { event?: unknown; data?: { reference?: unknown; transaction?: { reference?: unknown } } };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return { status: 200, body: { ignored: "not JSON" } };
    }

    if (event.event === "charge.success" && typeof event.data?.reference === "string") {
      const verified = await verifyTransaction(secret, event.data.reference, f);
      if (!verified.ok) return { status: 500, body: { error: "could not verify with Paystack" } };
      const { currency } = await getSettings(q);
      const recorded = await recordPaystackPayment(q, verified.value, currency);
      return { status: 200, body: { received: true, outcome: recorded.outcome } };
    }

    if (event.event === "charge.dispute.create") {
      const ref = event.data?.transaction?.reference ?? event.data?.reference;
      if (typeof ref !== "string") return { status: 200, body: { ignored: "dispute without a reference" } };
      const raised = await recordDispute(q, ref, await businessToday(q));
      return { status: 200, body: { received: true, task: raised } };
    }

    return { status: 200, body: { ignored: typeof event.event === "string" ? event.event : "no event" } };
  });
}
