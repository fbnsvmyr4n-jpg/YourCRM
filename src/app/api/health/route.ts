import { NextResponse } from "next/server";
import { authSecretConfigured } from "@/server/auth";
import { stripeConfigured, webhookSecret } from "@/server/billing/stripe";
import { PLANS, priceIdFor } from "@/server/billing/plans";
import { checkIsolation, pingDatabase } from "@/server/db";
import { storageEngine } from "@/server/store";

export const dynamic = "force-dynamic";

/**
 * Deployment health check.
 *
 * Reports whether the two pieces of configuration that fail *silently* are
 * actually in place: a real session signing key, and a database that persists.
 *
 * The storage check **opens a real connection and runs a query**. An earlier
 * version only checked that `DATABASE_URL` was set, and so happily reported
 * "ok: postgres" while the database was unreachable — which is exactly the
 * kind of false green that makes a health check worse than none.
 *
 * Reports booleans, timings and error messages — never the connection string
 * or the signing key — since this endpoint is unauthenticated by design so a
 * deploy can be verified before anyone signs in.
 */
export async function GET() {
  const engine = storageEngine();
  const secretOk = authSecretConfigured();

  const db = engine === "postgres" ? await pingDatabase() : null;

  /**
   * Whether tenant isolation can actually be enforced, not merely declared.
   *
   * A health check that says "ok" while every row-level policy is bypassed is
   * the false green this endpoint's own comment warns about — and that was the
   * exact state of production until 20 Aug, because the connecting role had
   * BYPASSRLS. Reported here so it is visible without anybody remembering to
   * go and look.
   */
  const isolation = engine === "postgres" && db?.ok ? await checkIsolation().catch(() => null) : null;
  const persistent = engine === "postgres" && db?.ok === true;
  // A green health check while every policy is bypassed is the false green this
  // endpoint exists to prevent, so isolation counts towards readiness.
  const isolated = isolation === null ? true : isolation.ok;
  /**
   * Billing, and specifically the half-configured state.
   *
   * Not having Stripe at all is fine — the app says so and the plan buttons are
   * unavailable. The dangerous configuration is a secret key WITHOUT a webhook
   * secret: checkout works, customers are charged, and every subscription event
   * is then refused by the endpoint. Payments succeed and no account ever
   * activates, with nothing on screen to suggest why.
   *
   * A missing price id is the same shape one step further along: the plan
   * cannot be bought, and the only symptom is a button that does nothing.
   */
  const billingOn = stripeConfigured();
  const missingPrices = billingOn ? PLANS.filter((p) => !priceIdFor(p)) : [];
  const billingBroken = billingOn && (!webhookSecret() || missingPrices.length > 0);

  const ready = secretOk && persistent && isolated && !billingBroken;

  return NextResponse.json(
    {
      status: ready ? "ok" : "degraded",
      checks: {
        sessionSigningKey: secretOk
          ? "ok"
          : "using the built-in dev key — set AUTH_SECRET",
        storage:
          engine !== "postgres"
            ? "not persistent: file store — set DATABASE_URL"
            : db?.ok
              ? `ok: postgres (${db.ms}ms)`
              : `postgres UNREACHABLE: ${db && !db.ok ? db.error : "unknown error"}`,
        tenantIsolation:
          isolation === null
            ? "not checked"
            : isolation.ok
              ? `ok: ${isolation.protectedTables} tables protected, role "${isolation.role}" is subject to them`
              : isolation.bypassesRls || isolation.superuser
                ? `INERT: role "${isolation.role}" ${isolation.bypassesRls ? "has BYPASSRLS" : "is a superuser"} — every row-level policy is skipped. Connect as a role without it.`
                : `INERT: no tables have row-level security enabled`,
        billing: !billingOn
          ? "not configured — plans cannot be changed (STRIPE_SECRET_KEY unset)"
          : !webhookSecret()
            ? "BROKEN: a secret key is set but STRIPE_WEBHOOK_SECRET is not — customers can be charged and no account will ever activate"
            : missingPrices.length > 0
              ? `BROKEN: no Stripe price configured for ${missingPrices.join(", ")} — those plans cannot be bought`
              : "ok: checkout, webhook and all prices configured",
      },
      engine,
    },
    { status: ready ? 200 : 503 }
  );
}
