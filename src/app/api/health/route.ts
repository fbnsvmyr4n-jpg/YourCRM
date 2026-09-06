import { NextResponse } from "next/server";
import { aiConfigured, quotationReadiness } from "@/server/ai";
import { authSecretConfigured } from "@/server/auth";
import { emailConfigured } from "@/server/email";
import { stripeConfigured, webhookSecret } from "@/server/billing/stripe";
import { PLANS, priceIdFor } from "@/server/billing/plans";
import { checkIsolation, checkSchema, pingDatabase } from "@/server/db";
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

  /**
   * Whether the database has the schema this build expects.
   *
   * Deploying code and migrating a database are two steps, and a process with
   * two steps will eventually do one of them. On 22 Aug that is precisely what
   * happened: the code shipped, the schema did not, and this endpoint reported
   * "ok" while `plan_entitlements` — read on every Settings load — was absent.
   */
  const schema = engine === "postgres" && db?.ok ? await checkSchema().catch(() => null) : null;
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

  /**
   * The quotation path's two external dependencies.
   *
   * Neither fails loudly, and between them they decide whether the feature this
   * product just shipped can happen at all — which nothing, anywhere, currently
   * reports. Without `ANTHROPIC_API_KEY` the assistant silently falls back to
   * the deterministic one: it still answers from real data, but it has no tools
   * and cannot draft a quotation, so the price list sits there and the thing a
   * person asks for does not happen. Without `RESEND_API_KEY` a quotation can
   * be drafted and approved and then goes nowhere.
   *
   * The dangerous combination is the same shape as billing's: **an assistant
   * that can draft and no way to send.** A workspace then approves quotes that
   * never reach anybody — the approval is recorded, the name is stamped, and
   * the client hears nothing. Called out on its own line rather than left to be
   * inferred from two "not configured" strings.
   *
   * Unlike billing, none of this makes the deployment unready. A workspace with
   * no assistant is a smaller product, not a broken one, and returning 503 for
   * it would take the site down in the eyes of anything watching this endpoint.
   */
  const ai = aiConfigured();
  const mail = emailConfigured();

  const schemaOk = schema === null ? true : schema.ok;
  const ready = secretOk && persistent && isolated && schemaOk && !billingBroken;

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
        schema:
          schema === null
            ? "not checked"
            : schema.ok
              ? "ok: the database matches this build"
              : `STALE: run \`npm run db:migrate\` — missing ${[
                  ...schema.missingTables,
                  ...schema.missingColumns,
                ].join(", ")}`,
        billing: !billingOn
          ? "not configured — plans cannot be changed (STRIPE_SECRET_KEY unset)"
          : !webhookSecret()
            ? "BROKEN: a secret key is set but STRIPE_WEBHOOK_SECRET is not — customers can be charged and no account will ever activate"
            : missingPrices.length > 0
              ? `BROKEN: no Stripe price configured for ${missingPrices.join(", ")} — those plans cannot be bought`
              : "ok: checkout, webhook and all prices configured",
        assistant: ai
          ? "ok: a model is configured — the agent can answer and draft quotations"
          : "not configured — the assistant answers from data only and CANNOT draft a quotation (ANTHROPIC_API_KEY unset)",
        outboundEmail: mail
          ? "ok: quotations, invites and password resets can be sent"
          : "not configured — nothing can be emailed (RESEND_API_KEY unset)",
        quotations: quotationReadiness(ai, mail),
      },
      engine,
      /**
       * Which build is answering, and where it thinks it is running.
       *
       * Added after an hour lost to a different question than the one being
       * asked. Two keys were set in the Vercel dashboard and a redeploy was
       * run, and this endpoint still reported them unset — with no way from
       * outside to tell whether the redeploy had landed, whether the domain
       * pointed at the project being edited, or whether the variables were
       * scoped to Preview rather than Production. Three very different
       * problems, one identical symptom.
       *
       * `VERCEL_GIT_COMMIT_SHA` and `VERCEL_ENV` are set by the platform. Both
       * are safe to state publicly: the repository is public, and the
       * environment name is not a secret. Absent locally, which is itself the
       * honest answer for a machine that is not a deployment.
       */
      deployment: {
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "not a Vercel deployment",
        environment: process.env.VERCEL_ENV ?? "local",
        /**
         * The deployment's own address, which is unique per deployment.
         *
         * The commit alone could not answer the question actually being asked.
         * Pressing Redeploy rebuilds the SAME commit, so a redeploy that worked
         * and a redeploy that never happened both report the same seven
         * characters — and we spent a cycle unable to tell them apart. This
         * changes every time a build is created, so it distinguishes them.
         *
         * Not a secret: it is the public hostname Vercel gives the deployment.
         */
        id: process.env.VERCEL_URL ?? "local",
      },
    },
    { status: ready ? 200 : 503 }
  );
}
