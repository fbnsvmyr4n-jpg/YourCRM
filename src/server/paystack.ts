import { createHmac, timingSafeEqual } from "node:crypto";
import type { CurrencyCode } from "@/lib/money";

/**
 * Paystack, spoken to directly over its REST API.
 *
 * No SDK: the four calls this product makes are small, and the official
 * OpenAPI description (PaystackOSS/openapi) is what these shapes follow —
 * amounts in the currency's smallest unit, a unique reference per attempt, and
 * webhooks signed with HMAC-SHA512 of the raw body under the secret key, sent in
 * `x-paystack-signature`.
 *
 * Each workspace connects ITS OWN Paystack account. The money goes to the
 * business that sent the invoice; YourCRM never holds it.
 *
 * `fetch` is injectable so tests exercise the real request and response
 * handling without touching the network.
 */

export const PAYSTACK_API = "https://api.paystack.co";

/** What Paystack settles in, from its API description. */
export const PAYSTACK_CURRENCIES = ["ZAR", "USD", "NGN", "GHS", "KES"] as const;

export function paystackTakes(currency: CurrencyCode): boolean {
  return (PAYSTACK_CURRENCIES as readonly string[]).includes(currency);
}

type Fetch = typeof fetch;

export type KeyShape = { ok: true; mode: "test" | "live" } | { ok: false; error: string };

/** Checked before any call: a public key pasted by mistake is the common error. */
export function checkKeyShape(raw: string): KeyShape {
  const k = raw.trim();
  if (/^pk_(test|live)_/.test(k)) {
    return { ok: false, error: "That is your PUBLIC key. Paste the secret key — it starts with sk_live_ or sk_test_." };
  }
  const m = /^sk_(test|live)_[A-Za-z0-9]{20,100}$/.exec(k);
  if (!m) return { ok: false, error: "That does not look like a Paystack secret key. It starts with sk_live_ or sk_test_." };
  return { ok: true, mode: m[1] as "test" | "live" };
}

async function call<T>(
  f: Fetch,
  secretKey: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown }
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  let res: Response;
  try {
    res = await f(`${PAYSTACK_API}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, status: 0, message: "Paystack could not be reached. Try again in a moment." };
  }
  let json: { status?: boolean; message?: string; data?: T } = {};
  try {
    json = await res.json();
  } catch {
    /* A non-JSON answer is still an answer; the status says what it was. */
  }
  if (!res.ok || json.status !== true) {
    return { ok: false, status: res.status, message: json.message ?? `Paystack answered ${res.status}` };
  }
  return { ok: true, data: json.data as T };
}

/** A key that Paystack accepts. A read with no effect: list one transaction. */
export async function verifySecretKey(secretKey: string, f: Fetch = fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  const out = await call<unknown>(f, secretKey, "/transaction?perPage=1", { method: "GET" });
  if (out.ok) return { ok: true };
  if (out.status === 401) return { ok: false, error: "Paystack did not accept that key. Copy it again from Settings → API Keys & Webhooks." };
  return { ok: false, error: out.message };
}

export type Initialized = { authorizationUrl: string; reference: string };

export async function initializeTransaction(
  secretKey: string,
  input: {
    email: string;
    amountCents: number;
    currency: CurrencyCode;
    reference: string;
    callbackUrl: string;
    metadata: Record<string, string>;
  },
  f: Fetch = fetch
): Promise<{ ok: true; value: Initialized } | { ok: false; error: string }> {
  const out = await call<{ authorization_url: string; reference: string }>(f, secretKey, "/transaction/initialize", {
    method: "POST",
    body: {
      email: input.email,
      amount: input.amountCents,
      currency: input.currency,
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    },
  });
  if (!out.ok) return { ok: false, error: out.message };
  return { ok: true, value: { authorizationUrl: out.data.authorization_url, reference: out.data.reference } };
}

export type Verified = {
  status: string;
  reference: string;
  amountCents: number;
  currency: string;
  paidAt: string | null;
  channel: string | null;
  metadata: Record<string, unknown>;
};

/**
 * What Paystack itself says happened to a reference.
 *
 * Asked every time before money is recorded — on the customer's return AND on
 * a webhook — because a redirect can be forged by anybody with a browser, and a
 * webhook body is only as good as the check that it matches Paystack's record.
 */
export async function verifyTransaction(
  secretKey: string,
  reference: string,
  f: Fetch = fetch
): Promise<{ ok: true; value: Verified } | { ok: false; error: string }> {
  const out = await call<{
    status: string;
    reference: string;
    amount: number;
    currency: string;
    paid_at: string | null;
    channel: string | null;
    metadata: unknown;
  }>(f, secretKey, `/transaction/verify/${encodeURIComponent(reference)}`, { method: "GET" });
  if (!out.ok) return { ok: false, error: out.message };
  const meta = out.data.metadata && typeof out.data.metadata === "object" ? (out.data.metadata as Record<string, unknown>) : {};
  return {
    ok: true,
    value: {
      status: out.data.status,
      reference: out.data.reference,
      amountCents: out.data.amount,
      currency: out.data.currency,
      paidAt: out.data.paid_at,
      channel: out.data.channel,
      metadata: meta,
    },
  };
}

/** Whether a webhook body really came from the Paystack account holding this key. */
export function signatureMatches(rawBody: string, signature: string | null, secretKey: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(createHmac("sha512", secretKey).update(rawBody).digest("hex"));
  const given = Buffer.from(signature.trim().toLowerCase());
  return expected.length === given.length && timingSafeEqual(expected, given);
}
