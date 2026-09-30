import { Client } from "pg";
import { SYSTEM_TABLES } from "../src/server/tenant";

/**
 * Prove that the restricted application role can see nothing without a tenant.
 *
 *   DATABASE_URL=<the yourcrm_app url> npm run check:rls
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A TEST. The suite runs against PGlite as a
 * superuser, so row-level security is switched off in it: every isolation test
 * passes whether the policies work or not. That gap has already cost one
 * production defect — the public booking and enquiry pages used `withSystem`,
 * which sets no tenant, so under the real role they returned nothing and every
 * published link would have 404'd. Production happened to have no published
 * links, so no customer hit it. Nothing in 2,900 tests could have found it.
 *
 * This connects as the role the application actually runs as and asks the only
 * question that matters: with no tenant and no public key set, what can it see?
 * The answer has to be nothing.
 *
 * READ-ONLY. Every statement is a SELECT inside a transaction that is rolled
 * back, so it is safe against production — which is the point, because
 * production is the database whose policies matter.
 */

/**
 * Tables that carry a tenant column but are deliberately not tenant-scoped.
 *
 * The same allowlist `tenant-context.test.ts` keeps, and for the same reason:
 * `users` is agency-level because signing in happens before a workspace is
 * chosen. Everything else decides itself — a table is tenant data if it has a
 * `sub_account_id`, which is exactly how `isolation.test.ts` defines one.
 *
 * Tables with no tenant column at all are skipped without being listed. That
 * covers the shared price list, the retired JSONB store, agency-level billing
 * (`referral_credits`, `stripe_events`) and `voice_sessions` — which is
 * untenanted on purpose, because a telephony webhook arrives before anything
 * knows whose call it is. Each of those carries its reasoning in `schema.sql`.
 */
const NOT_TENANT_SCOPED = new Set<string>(SYSTEM_TABLES);

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL is not set. Use the RESTRICTED role's url, not the owner's.");
    process.exit(1);
  }

  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "unknown host";
    }
  })();

  const client = new Client({
    connectionString: url,
    ssl: /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(host) ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const { rows: who } = await client.query<{ user: string; bypass: boolean }>(
      `SELECT current_user AS user, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    );
    console.log(`Connected to ${host} as ${who[0].user}`);

    /* A role that can bypass RLS answers every question below with "yes, I can
       see it" whether the policies work or not — which is exactly how this
       class of bug hides. Refused rather than reported, so a green run can
       never come from the wrong connection string. */
    if (who[0].bypass) {
      console.error(
        `\n${who[0].user} can BYPASS row-level security, so this check would prove nothing.\n` +
          `Run it with the restricted application role (.env.production.app), not the owner.`
      );
      process.exit(1);
    }

    await client.query("BEGIN");

    const { rows: tables } = await client.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY 1`
    );

    const leaks: string[] = [];
    const unprotected: string[] = [];
    let checked = 0;

    const { rows: tenantCols } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'sub_account_id'`
    );
    const tenantTables = new Set(tenantCols.map((r) => r.table_name));

    for (const { table_name: table } of tables) {
      /* Tenant data is whatever carries a tenant. A table without one is
         outside this model entirely and has its own note in the schema. */
      if (!tenantTables.has(table) || NOT_TENANT_SCOPED.has(table)) continue;
      checked++;

      const { rows: guard } = await client.query<{ rls: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1`,
        [table]
      );
      if (!guard[0]?.rls || !guard[0]?.forced) {
        unprotected.push(`${table} (enabled=${guard[0]?.rls}, forced=${guard[0]?.forced})`);
      }

      /* No tenant, no public key: a request that has not identified itself.
         Anything it can read is readable by anybody who reaches the app. */
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${JSON.stringify(table).replace(/"/g, '"')}`
      );
      if (Number(rows[0].n) > 0) leaks.push(`${table}: ${rows[0].n} rows`);
    }

    await client.query("ROLLBACK");

    console.log(`\nChecked ${checked} tenant tables with no tenant set.`);

    if (unprotected.length) {
      console.error(`\nNOT PROTECTED — row-level security is not enabled AND forced on:`);
      for (const t of unprotected) console.error(`  ${t}`);
    }
    if (leaks.length) {
      console.error(`\nVISIBLE WITHOUT A TENANT — anybody reaching the app can read these:`);
      for (const t of leaks) console.error(`  ${t}`);
    }
    if (unprotected.length || leaks.length) process.exit(1);

    console.log("Nothing is visible without a tenant. The policies hold for this role.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
