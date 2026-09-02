import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDb } from "./helpers/pg";

/**
 * The migration, rehearsed against a real copy of production.
 *
 * `migration.test.ts` checks the rules with fixtures written to exercise them.
 * This checks the one thing fixtures cannot: that the migration survives the
 * actual data. The first rehearsal found three defects no unit test had —
 * a collection read by the wrong name, timestamps that depended on which
 * machine ran the migration, and a verification structurally incapable of
 * failing.
 *
 * It is a TEST rather than a script so it re-runs whenever the schema changes.
 * The schema has changed four times since that first rehearsal — split
 * payments, a per-tenant time zone, call topics and a sub-account phone
 * number — and each one silently invalidated the rehearsal I had already done.
 *
 * Skips when no copy is present, which is the normal case: the copy holds real
 * customer data and is never committed. Refresh it with the dump script before
 * running the migration for real.
 */

const COPY = process.env.PROD_COPY ?? join(__dirname, "..", "..", "prod-copy.json");
const SCRATCH =
  "/private/tmp/claude-501/-Users-daddyspanky-CRM-System-01-/6cb642e3-bbee-434b-8328-48ec312335ae/scratchpad/prod-copy.json";

const copyPath = existsSync(COPY) ? COPY : existsSync(SCRATCH) ? SCRATCH : null;

const opts = {
  agencyId: "ag_yourcrm",
  agencyName: "YourCRM",
  subAccountId: "sa_main",
  subAccountName: "Main workspace",
  // Stated, not guessed. Every legacy timestamp is a wall-clock string with no
  // zone, so this decides what "2:00 pm" meant.
  legacyTimeZone: "Africa/Johannesburg",
};

describe.skipIf(!copyPath)("migrating a copy of production", () => {
  let db: TestDb;
  let withSystem: typeof import("../src/server/tenant").withSystem;
  let withTenant: typeof import("../src/server/tenant").withTenant;
  let run: typeof import("../src/server/migrate/run");
  let reportData: typeof import("../src/server/analytics").reportData;
  let closePool: typeof import("../src/server/db").closePool;

  let legacy: Awaited<ReturnType<typeof run.loadLegacy>>;
  let report: Awaited<ReturnType<typeof run.migrate>>;
  let verification: Awaited<ReturnType<typeof run.verify>>;

  beforeAll(async () => {
    db = await startTestDb();
    ({ withSystem, withTenant } = await import("../src/server/tenant"));
    ({ closePool } = await import("../src/server/db"));
    ({ reportData } = await import("../src/server/analytics"));
    run = await import("../src/server/migrate/run");

    // The legacy store, recreated exactly as production has it.
    await db.seed(`CREATE TABLE IF NOT EXISTS crm_collections (
      name TEXT PRIMARY KEY, data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

    const copy = JSON.parse(readFileSync(copyPath!, "utf8")) as Record<string, unknown>;
    for (const [name, data] of Object.entries(copy)) {
      await db.seed(
        `INSERT INTO crm_collections (name, data) VALUES ('${name}', '${JSON.stringify(data).replace(/'/g, "''")}'::jsonb)
         ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data`
      );
    }

    legacy = await withSystem((q) => run.loadLegacy(q));
    report = await withSystem((q) => run.migrate(q, legacy, opts));
    verification = await withSystem((q) =>
      run.verify(q, legacy, opts.subAccountId, opts.legacyTimeZone)
    );
  });

  afterAll(async () => {
    await closePool?.();
    await db.stop();
  });

  it("reads every collection it expects to find", () => {
    // The defect this catches: the loader asked for `inbox` when the collection
    // is called `messages`, and Postgres returned an empty array rather than an
    // error — so every message would have migrated as zero.
    expect(legacy.contacts.length, "no contacts were read").toBeGreaterThan(0);
    expect(legacy.deals.length, "no deals were read").toBeGreaterThan(0);
    expect(legacy.meetings.length, "no meetings were read").toBeGreaterThan(0);
    expect(legacy.messages.length, "no messages were read — check the collection name").toBeGreaterThan(0);
  });

  it("reads every collection the copy contains", () => {
    /**
     * The check that was missing, and the reason it mattered.
     *
     * `readCollection` returns an empty array for a name that does not exist,
     * so four collections — users, calls, activity and chat — looked like
     * empty collections rather than missing ones. Nothing failed. Six people
     * could sign in before the migration and none of them after it, and the
     * first anybody would have known is nobody being able to log in.
     *
     * So the copy is compared against what the migration says it read, rather
     * than against a list I would have to remember to update.
     */
    const copy = JSON.parse(readFileSync(copyPath!, "utf8")) as Record<string, unknown[]>;
    const populated = Object.entries(copy)
      .filter(([, rows]) => Array.isArray(rows) && rows.length > 0)
      .map(([name]) => name);

    // Two are deliberately not migrated, each for a stated reason.
    const NOT_MIGRATED: Record<string, string> = {
      login_attempts: "rate-limit counters; stale within fifteen minutes and worthless afterwards",
      password_resets: "single-use tokens with a one-hour life; carrying them across is pointless",
    };

    for (const name of populated) {
      if (name in NOT_MIGRATED) continue;
      const read = report.read[name === "leads" ? "leads" : name];
      expect(
        read,
        `the copy has ${(copy[name] as unknown[]).length} rows in "${name}" and the migration read none — check the collection name`
      ).toBeGreaterThan(0);
    }
  });

  it("carries the accounts people sign in with", () => {
    // The single worst thing this migration could drop. Hashes move as-is:
    // rehashing them would lock everybody out just as thoroughly.
    expect(legacy.users.length, "no users were read").toBeGreaterThan(0);
    expect(report.written.users).toBe(legacy.users.length);
  });

  it("carries the voice agent's history", () => {
    expect(report.written.calls).toBe(legacy.calls.length);
  });

  it("reconciles every deal and every penny", () => {
    const deals = verification.checks.find((c) => c.name === "deals")!;
    const money = verification.checks.find((c) => c.name === "deal value in cents")!;
    expect(deals.ok, `expected ${deals.expected} deals, got ${deals.actual}`).toBe(true);
    expect(money.ok, `expected ${money.expected} cents, got ${money.actual}`).toBe(true);
  });

  it("does not duplicate anybody who was both a contact and a lead", () => {
    const contacts = verification.checks.find((c) => c.name === "contacts (at least)")!;
    expect(contacts.ok).toBe(true);
    // Every legacy contact survives, and leads add only the people who did not
    // already exist. More than the sum of both would mean a merge failed.
    expect(contacts.actual).toBeLessThanOrEqual(legacy.contacts.length + legacy.leads.length);
  });

  it("reports the meetings it cannot date instead of dropping them quietly", () => {
    const skipped = verification.checks.find((c) => c.name === "meetings skipped (no date)")!;
    // These are old rows with a time and a relative label but no date, and the
    // label was relative to a moment nobody recorded. Bradley agreed to skip
    // them; what matters is that the number is reported rather than hidden.
    expect(skipped.actual, "the count of undated meetings changed — re-check before running").toBe(5);
    expect(report.warnings.filter((w) => w.includes("skipped")).length).toBe(skipped.actual);
  });

  it("leaves no unmapped value silently filed as a default", () => {
    // Every warning should be a skipped meeting. Anything else means a value in
    // the real data has no mapping and was quietly filed somewhere.
    const unexpected = report.warnings.filter((w) => !w.includes("skipped"));
    expect(unexpected, `unmapped values found:\n${unexpected.join("\n")}`).toEqual([]);
  });

  it("produces data the application can actually read back", async () => {
    /**
     * The step the first rehearsal did not take. A migration that writes rows
     * the product cannot render is a migration that passed its own checks and
     * still broke the site — so the reports layer is run against the result.
     */
    const r = await withTenant(
      { agencyId: opts.agencyId, subAccountId: opts.subAccountId, userId: "u", role: "owner" },
      (q) => reportData(q)
    );

    expect(r.contacts.total).toBeGreaterThan(0);
    expect(r.byStage).toHaveLength(7);
    expect(r.revenue.wonCents).toBeGreaterThan(0);

    // Every source total must add up to the reported won revenue. If they do
    // not, attribution is losing money somewhere between the two queries.
    const bySource = r.bySource.reduce((sum, s) => sum + s.wonCents, 0);
    expect(bySource, "source totals do not add up to won revenue").toBe(r.revenue.wonCents);
  });
});
