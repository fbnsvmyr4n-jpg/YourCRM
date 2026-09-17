"use server";

import { redirect } from "next/navigation";
import { checkRate, payKey, registerAttempt } from "@/server/repos/auth";
import { clientIp } from "@/server/client-ip";
import { withSystem } from "@/server/tenant";
import { startPayment } from "@/server/pay/pay";

/**
 * The pay page's one action: go to Paystack.
 *
 * Listed in `PUBLIC_ACTIONS` in the authorisation suite, with the reason. What
 * stands in for a session: the unguessable token, which opens exactly one
 * invoice; a per-address rate limit checked first; and an amount the server
 * decides — the browser sends the token and nothing else.
 */
export type PayState = { error: string } | undefined;

export async function payAction(_prev: PayState, formData: FormData): Promise<PayState> {
  const keys = [payKey(await clientIp())];
  const verdict = await withSystem((q) => checkRate(q, keys));
  if (!verdict.allowed) {
    const mins = Math.max(1, Math.ceil(verdict.retryAfterSec / 60));
    return { error: `Too many attempts from this connection. Please try again in ${mins} minute${mins === 1 ? "" : "s"}.` };
  }
  await withSystem((q) => registerAttempt(q, keys));

  const out = await startPayment(String(formData.get("token") ?? ""));
  if ("error" in out) return { error: out.error };
  redirect(out.url);
}
