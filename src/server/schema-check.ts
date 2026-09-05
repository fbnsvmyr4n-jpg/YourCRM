/**
 * What schema this build expects.
 *
 * The lists only. The query that compares them against a live database lives in
 * `db.ts`, which is the one module allowed to reach the connection pool — the
 * rule that keeps every other data path going through a tenant-scoped querier.
 *
 * Nothing in the application applies `schema.sql`, and on 22 Aug 2026 that
 * failed exactly as you would expect it to: three commits changed the schema,
 * the code deployed, the schema did not, and production ran new code against an
 * old database. `plan_entitlements` — read on every Settings load — simply was
 * not there. The health endpoint reported "ok" throughout, because it checked
 * the connection and the policies and had no opinion about the shape.
 *
 * Deploying code and migrating a database are two steps, and a deploy process
 * with two steps will eventually do one of them. This makes the gap visible
 * within a request rather than at whatever point a customer opens the page that
 * happens to need the missing table.
 *
 * The expected tables are listed here rather than parsed from `schema.sql` at
 * runtime: reading a file on every health check is a cost, and the file is not
 * reliably on disk in a serverless bundle. The list is pinned by a test that
 * DOES read the schema, so it cannot drift from it.
 */

/** Every table `schema.sql` declares, as of this build. */
export const EXPECTED_TABLES = [
  "agencies",
  "sub_accounts",
  "users",
  "settings",
  "contacts",
  "companies",
  "deals",
  "meetings",
  "messages",
  "activities",
  "calls",
  "voice_sessions",
  "chat_messages",
  "password_resets",
  "login_attempts",
  "plan_entitlements",
  "stripe_events",
  "usage_events",
  "referral_credits",
] as const;

/** Columns added by `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, which a stale
 *  database is most likely to be missing while still having the table. */
export const EXPECTED_COLUMNS: ReadonlyArray<[string, string]> = [
  ["agencies", "billing_synced_at"],
  ["agencies", "referral_code"],
  ["agencies", "referred_by_agency_id"],
  /* Win Rate is computed from it, and the failure is worse than a wrong
     number: the column is named inside the period filter, so on a database
     that has not been migrated every Reports view EXCEPT All time fails
     outright with "column lost_at does not exist". All time omits the filter
     and keeps working, which is the cruel part — the page looks healthy until
     somebody picks a month. */
  ["deals", "lost_at"],
  /* The staff directory. Named in the SELECT that every read of `users` goes
     through, so on an unmigrated database this is not a missing field on one
     screen — it is sign-in itself failing, because `findUserByEmail` reads the
     same columns. */
  ["users", "department"],
  ["users", "job_title"],
  ["users", "phone"],
  ["users", "scope"],
];

export type SchemaCheck = {
  ok: boolean;
  missingTables: string[];
  missingColumns: string[];
};
