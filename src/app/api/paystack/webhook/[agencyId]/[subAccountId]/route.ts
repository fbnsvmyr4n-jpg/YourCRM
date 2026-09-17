import { NextResponse } from "next/server";
import { handlePaystackWebhook } from "@/server/pay/webhook";
import { logDenied } from "@/server/log";

export const dynamic = "force-dynamic";
/* The signature is over the exact bytes Paystack sent, so the body is read as text. */
export const runtime = "nodejs";

/**
 * Paystack's webhook, one URL per workspace — shown in Settings → Payments for
 * the business to paste into its own Paystack dashboard.
 *
 * Unauthenticated by nature; the signature, checked with that workspace's key,
 * is the whole of the protection. See `server/pay/webhook.ts`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ agencyId: string; subAccountId: string }> }) {
  const { agencyId, subAccountId } = await params;
  const body = await request.text();
  try {
    const out = await handlePaystackWebhook(agencyId, subAccountId, body, request.headers.get("x-paystack-signature"));
    if (out.status === 401) logDenied("paystack-webhook", "signature did not match");
    return NextResponse.json(out.body, { status: out.status });
  } catch (err) {
    console.error("[paystack-webhook] failed to apply event", (err as Error).message);
    return NextResponse.json({ error: "could not process" }, { status: 500 });
  }
}
