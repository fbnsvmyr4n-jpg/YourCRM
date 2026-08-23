import { writeFileSync } from "node:fs";
import { Client } from "pg";
import { takeBackup } from "../src/server/backup";

/**
 * Take a backup.
 *
 *   DATABASE_URL=... npm run db:backup -- ./backup.json
 *
 * Data only. The schema is `schema.sql`, applied by `db:migrate`, so a restore
 * into an empty database is "migrate, then restore" — two steps that are each
 * already proven, rather than one that keeps a second copy of the schema and
 * lets the two drift.
 */
async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const out = process.argv[2] ?? `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
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

  console.log(`Backing up ${host}`);
  // A raw client behaves as the pool client the backup expects.
  const backup = await takeBackup(client as never);
  await client.end();

  writeFileSync(out, JSON.stringify(backup, null, 2));

  const total = Object.values(backup.manifest.rowCounts).reduce((a, b) => a + b, 0);
  console.log(`Wrote ${out} — ${backup.manifest.tables.length} tables, ${total} rows.`);
  for (const [table, n] of Object.entries(backup.manifest.rowCounts)) {
    if (n > 0) console.log(`  ${table.padEnd(20)} ${n}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
