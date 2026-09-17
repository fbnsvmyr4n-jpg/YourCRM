"use server";

import { revalidateApp } from "@/server/revalidate";
import { roleCan } from "@/server/permissions";
import { withCurrentTenant } from "@/server/tenant-session";
import { connectPaystack, disconnectPaystack } from "@/server/repos/payments";
import { logWrite } from "@/server/log";
import type { FormState } from "./actions";

/**
 * Connecting the workspace's own Paystack account.
 *
 * Money settings, so `manage_billing` — the owner and accounts — and not the
 * customer-data gate: accounts people are exactly who set up how clients pay,
 * and nothing here reads a customer record.
 *
 * The key is never logged, never returned, and never put back into the form.
 */
const NOT_YOURS = "Only the owner or accounts can change how clients pay.";

export async function connectPaystackAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(
    async (q) => {
      if (!roleCan(q.ctx.role, "manage_billing")) return { error: NOT_YOURS };
      const raw = formData.get("secretKey");
      if (typeof raw !== "string" || !raw.trim()) return { error: "Paste your Paystack secret key." };
      const out = await connectPaystack(q, raw.slice(0, 200));
      if ("error" in out) return { error: out.error };
      logWrite("update", "payment_connection", { id: q.ctx.subAccountId, actor: q.ctx.userId, detail: out.connection.mode });
      revalidateApp();
      return {
        ok:
          out.connection.mode === "test"
            ? "Connected in TEST mode — no real money moves. Connect your live key when you are ready."
            : "Connected. Invoices you send now carry a Pay now link.",
      };
    },
    { crmData: false }
  );
}

export async function disconnectPaystackAction(_prev: FormState): Promise<FormState> {
  return withCurrentTenant(
    async (q) => {
      if (!roleCan(q.ctx.role, "manage_billing")) return { error: NOT_YOURS };
      const removed = await disconnectPaystack(q);
      if (removed) logWrite("delete", "payment_connection", { id: q.ctx.subAccountId, actor: q.ctx.userId });
      revalidateApp();
      return { ok: "Disconnected. Pay links already sent now show your bank details instead." };
    },
    { crmData: false }
  );
}
