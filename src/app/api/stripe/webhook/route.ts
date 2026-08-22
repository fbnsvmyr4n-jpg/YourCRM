import { NextResponse } from "next/server";
import { handleStripeEvent, type HandledEvent } from "@/server/billing/webhook";
import { stripe, stripeConfigured, webhookSecret } from "@/server/billing/stripe";
import { logDenied } from "@/server/log";
import { withSystem } from "@/server/tenant";

export const dynamic = "force-dynamic";
// The signature is computed over the exact bytes Stripe sent. Any parsing,
// re-encoding or body-size middleware in front of this invalidates it, which is
// why the body is read as text and never as JSON.
export const runtime = "nodejs";

/**
 * Stripe's webhook endpoint.
 *
 * This is the only unauthenticated endpoint in the application that WRITES, so
 * the signature check is the entire security boundary. Without it, anyone who
 * learns the URL can post a JSON body granting themselves the SaaS Pro plan.
 *
 * The handler returns 200 for anything it has decided about — including events
 * it deliberately ignores. A non-2xx tells Stripe to retry, and retrying an
 * event that will never be handled means it is redelivered for days. 4xx and
 * 5xx are reserved for "we could not decide", which is the only case where a
 * retry helps.
 */
export async function POST(request: Request) {
  const client = stripe();
  const secret = webhookSecret();

  if (!client || !stripeConfigured() || !secret) {
    // 503 rather than 200: this IS retryable, and a deployment missing its
    // billing configuration should not silently swallow subscription changes.
    logDenied("stripe-webhook", "billing is not configured on this deployment");
    return NextResponse.json({ error: "billing not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    logDenied("stripe-webhook", "request carried no signature");
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  const body = await request.text();

  let event: HandledEvent;
  try {
    // Verification, not decoding. `constructEvent` checks the HMAC and the
    // timestamp — the latter is what stops a genuine, captured event being
    // replayed months later.
    event = client.webhooks.constructEvent(body, signature, secret) as unknown as HandledEvent;
  } catch (err) {
    // The reason is not echoed back. A caller probing the endpoint learns only
    // that the signature failed, never which part of it.
    logDenied("stripe-webhook", `signature verification failed: ${(err as Error).name}`);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    const outcome = await withSystem((q) => handleStripeEvent(q, event));
    if (!outcome.ok) {
      // A malformed but genuinely-signed event. Retrying will not fix it.
      logDenied("stripe-webhook", outcome.reason);
      return NextResponse.json({ received: true, ignored: outcome.reason }, { status: 200 });
    }
    return NextResponse.json({ received: true, action: outcome.action }, { status: 200 });
  } catch (err) {
    // A database failure. This one SHOULD be retried, so it must not return 200.
    console.error("[stripe-webhook] failed to apply event", (err as Error).message);
    return NextResponse.json({ error: "could not process" }, { status: 500 });
  }
}
