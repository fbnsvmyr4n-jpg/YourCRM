import { NextResponse } from "next/server";
import { authSecretConfigured } from "@/server/auth";
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
  const ready = secretOk && persistent && isolated;

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
      },
      engine,
    },
    { status: ready ? 200 : 503 }
  );
}
