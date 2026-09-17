import { withPublicLookup, withTenant, type TenantContext } from "../tenant";
import { findInvoice } from "../repos/invoices";
import { getSettings } from "../repos/settings";
import {
  getConnection,
  paidCents,
  paymentReference,
  paystackSecret,
  recordPaystackPayment,
  resolvePayToken,
  type PayLink,
  type Recorded,
} from "../repos/payments";
import { initializeTransaction, paystackTakes, verifyTransaction } from "../paystack";
import { appUrl } from "../billing/stripe";
import type { CurrencyCode } from "@/lib/money";
import { logWrite } from "../log";

/**
 * The public pay page: an invoice somebody was sent, and a button that takes
 * them to Paystack.
 *
 * Nobody here is signed in. The pay token in the URL is the whole of the
 * authority, and it opens exactly one invoice (see `withPublicLookup`). The
 * workspace acts as itself, the way the scheduled sweep does — nothing it does
 * reaches past that one invoice.
 */

const asWorkspace = (link: PayLink): TenantContext => ({
  agencyId: link.agencyId,
  subAccountId: link.subAccountId,
  userId: "",
  role: "owner",
});

export type PayPage =
  | { state: "not_found" }
  | {
      state: "payable" | "paid" | "unavailable";
      /** Why it cannot be paid here, in words for the client. */
      reason: string | null;
      workspaceName: string;
      number: string;
      project: string;
      dueOn: string | null;
      currency: CurrencyCode;
      lines: { description: string; quantity: number; unitCents: number; totalCents: number }[];
      totalCents: number;
      outstandingCents: number;
      payTo: string | null;
      testMode: boolean;
    };

async function resolve(token: string): Promise<PayLink | null> {
  if (typeof token !== "string" || !token) return null;
  return withPublicLookup("pay_token", token, (sys) => resolvePayToken(sys, token));
}

export async function loadPayPage(token: string): Promise<PayPage> {
  const link = await resolve(token);
  if (!link) return { state: "not_found" };

  return withTenant(asWorkspace(link), async (q) => {
    const invoice = await findInvoice(q, link.documentId);
    if (!invoice) return { state: "not_found" as const };
    const { currency } = await getSettings(q);
    const connection = await getConnection(q);
    const received = await paidCents(q, invoice.id);
    const outstanding = Math.max(0, invoice.totalCents - received);

    let state: "payable" | "paid" | "unavailable" = "payable";
    let reason: string | null = null;
    if (invoice.status === "paid" || outstanding === 0) {
      state = "paid";
    } else if (!invoice.sentAt) {
      state = "unavailable";
      reason = "This invoice has not been issued yet.";
    } else if (invoice.status === "cancelled") {
      state = "unavailable";
      reason = "This invoice has been cancelled.";
    } else if (!connection) {
      state = "unavailable";
      reason = `${link.workspaceName} does not take card payments online. Use the payment details below.`;
    } else if (!paystackTakes(currency)) {
      state = "unavailable";
      reason = `Online payment is not available in ${currency}. Use the payment details below.`;
    } else if (!invoice.partyEmail) {
      state = "unavailable";
      reason = `Online payment needs an email address on file. Contact ${link.workspaceName} to pay.`;
    }

    return {
      state,
      reason,
      workspaceName: link.workspaceName,
      number: invoice.number,
      project: invoice.projectTitle,
      dueOn: invoice.dueOn,
      currency,
      lines: invoice.lines,
      totalCents: invoice.totalCents,
      outstandingCents: outstanding,
      payTo: invoice.payTo,
      testMode: connection?.mode === "test",
    };
  });
}

/** Start a Paystack checkout for what is still owed. Returns where to send the browser. */
export async function startPayment(token: string, f: typeof fetch = fetch): Promise<{ url: string } | { error: string }> {
  const page = await loadPayPage(token);
  if (page.state === "not_found") return { error: "This payment link is not valid." };
  if (page.state === "paid") return { error: "This invoice has already been paid." };
  if (page.state === "unavailable") return { error: page.reason ?? "This invoice cannot be paid online." };

  const link = (await resolve(token))!;
  return withTenant(asWorkspace(link), async (q) => {
    const secret = await paystackSecret(q);
    const invoice = await findInvoice(q, link.documentId);
    if (!secret || !invoice?.partyEmail) {
      return { error: `Online payment is not available right now. Contact ${link.workspaceName} to pay.` };
    }
    const reference = paymentReference(invoice.id);
    const started = await initializeTransaction(
      secret,
      {
        email: invoice.partyEmail,
        amountCents: page.outstandingCents,
        currency: page.currency,
        reference,
        callbackUrl: `${appUrl()}/pay/${token}`,
        metadata: { invoice: invoice.number, workspace: link.workspaceName },
      },
      f
    );
    if (!started.ok) {
      /* Paystack's own wording can be about the merchant's account; the client
         gets a sentence they can act on, the log keeps the rest. */
      console.error("[pay] Paystack refused to start a payment:", started.error);
      return { error: "Paystack could not start the payment. Please try again in a moment." };
    }
    logWrite("create", "payment_attempt", { id: invoice.id, actor: "public" });
    return { url: started.value.authorizationUrl };
  });
}

/**
 * The client is back from Paystack. Ask Paystack what really happened.
 *
 * The `reference` in the return URL is only a question: anybody can type one.
 * It must name THIS invoice, and Paystack must say it succeeded, for the right
 * amount in the right currency, before a payment is recorded.
 */
export async function confirmReturn(
  token: string,
  reference: string,
  f: typeof fetch = fetch
): Promise<Recorded | { outcome: "failed"; message: string }> {
  const link = await resolve(token);
  if (!link) return { outcome: "ignored", reason: "no such link" };
  if (!reference.startsWith(`yc_${link.documentId}_`)) return { outcome: "ignored", reason: "reference is for another invoice" };

  return withTenant(asWorkspace(link), async (q) => {
    const secret = await paystackSecret(q);
    if (!secret) return { outcome: "ignored" as const, reason: "not connected" };
    const verified = await verifyTransaction(secret, reference, f);
    if (!verified.ok) return { outcome: "ignored" as const, reason: verified.error };
    if (verified.value.status !== "success") {
      return {
        outcome: "failed" as const,
        message:
          verified.value.status === "abandoned"
            ? "The payment was not completed. You can try again."
            : "The payment did not go through. Nothing was taken — you can try again.",
      };
    }
    const { currency } = await getSettings(q);
    return recordPaystackPayment(q, verified.value, currency);
  });
}
