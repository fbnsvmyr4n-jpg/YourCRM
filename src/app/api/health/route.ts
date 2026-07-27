import { NextResponse } from "next/server";
import { authSecretConfigured } from "@/server/auth";
import { pingDatabase } from "@/server/db";
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
  const persistent = engine === "postgres" && db?.ok === true;
  const ready = secretOk && persistent;

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
      },
      engine,
    },
    { status: ready ? 200 : 503 }
  );
}
