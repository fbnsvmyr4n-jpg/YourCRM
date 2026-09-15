"use server";

import { checkRate, enquiryKey, registerAttempt } from "@/server/repos/auth";
import { enquire } from "@/server/enquiry/enquire";
import { clientIp } from "@/server/client-ip";
import { withSystem } from "@/server/tenant";

/**
 * The public enquiry form's one action.
 *
 * Listed in `PUBLIC_ACTIONS` in the authorisation suite, with the reason. What
 * stands in for a session: a per-address rate limit that refuses before any
 * work, a slug that only resolves when its owner published enquiries, bounded
 * and checked inputs, and a trap field for the simplest bots. See
 * `server/enquiry/enquire.ts`.
 */

export type EnquireState =
  | { ok: true; workspaceName: string }
  | { ok: false; error: string }
  | undefined;

export async function enquireAction(_prev: EnquireState, formData: FormData): Promise<EnquireState> {
  const keys = [enquiryKey(await clientIp())];

  const verdict = await withSystem((q) => checkRate(q, keys));
  if (!verdict.allowed) {
    const mins = Math.max(1, Math.ceil(verdict.retryAfterSec / 60));
    return {
      ok: false,
      error: `Too many messages from this connection. Please try again in ${mins} minute${mins === 1 ? "" : "s"}.`,
    };
  }
  /* Counted before the enquiry runs, success or not: the abuse on a public
     write is volume, and a counter that only moved on failure would let
     somebody fill the Leads screen with successful submissions. */
  await withSystem((q) => registerAttempt(q, keys));

  const outcome = await enquire({
    slug: String(formData.get("slug") ?? ""),
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    message: String(formData.get("message") ?? ""),
    trap: String(formData.get("company_fax") ?? ""),
  });

  return outcome.ok
    ? { ok: true, workspaceName: outcome.workspaceName }
    : { ok: false, error: outcome.detail };
}
