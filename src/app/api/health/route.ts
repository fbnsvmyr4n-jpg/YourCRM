import { NextResponse } from "next/server";
import { authSecretConfigured } from "@/server/auth";
import { storageEngine } from "@/server/store";

export const dynamic = "force-dynamic";

/**
 * Deployment health check.
 *
 * Reports whether the two pieces of configuration that fail *silently* are
 * actually in place: a real session signing key, and a database that persists.
 * Deliberately reports only booleans and the engine name — never the values,
 * since this endpoint is unauthenticated by design so a deploy can be verified
 * before anyone signs in.
 */
export async function GET() {
  const engine = storageEngine();
  const secretOk = authSecretConfigured();
  const persistent = engine === "postgres";
  const ready = secretOk && persistent;

  return NextResponse.json(
    {
      status: ready ? "ok" : "degraded",
      checks: {
        sessionSigningKey: secretOk
          ? "ok"
          : "using the built-in dev key — set AUTH_SECRET",
        storage: persistent
          ? "ok: postgres"
          : "not persistent: file store — set DATABASE_URL",
      },
      engine,
    },
    { status: ready ? 200 : 503 }
  );
}
