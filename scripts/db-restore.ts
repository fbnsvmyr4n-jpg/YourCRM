import { readFileSync } from "node:fs";
import { Client } from "pg";
import { compareToBackup, restoreBackup, type Backup } from "../src/server/backup";

/**
 * Restore a backup, and check it landed.
 *
 *   DATABASE_URL=... npm run db:restore -- ./backup.json [--overwrite]
 *
 * The comparison is not optional. A restore that reports success and is wrong
 * is the failure this whole exercise exists to prevent, and the only way to
 * know is to read every row back and compare it to the file.
 */
async function main() {
  const url = process.env.DATABASE_URL?.trim();
  const file = process.argv[2];
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  if (!file) {
    console.error("Usage: npm run db:restore -- ./backup.json [--overwrite]");
    process.exit(1);
  }

  const overwrite = process.argv.includes("--overwrite");
  const backup = JSON.parse(readFileSync(file, "utf8")) as Backup;

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

  console.log(`Restoring ${file} into ${host}${overwrite ? " (overwriting)" : ""}`);

  try {
    // One transaction. A restore that fails halfway leaves a database that is
    // neither the old one nor the new one, and nothing to say which rows are
    // which.
    await client.query("BEGIN");
    const { restored, skipped } = await restoreBackup(client as never, backup, { overwrite });
    await client.query("COMMIT");

    const total = Object.values(restored).reduce((a, b) => a + b, 0);
    console.log(`Restored ${total} rows.`);

    // Named loudly. A restore that quietly leaves rows behind is the failure
    // this whole exercise exists to prevent.
    const left = Object.entries(skipped).filter(([, n]) => n > 0);
    if (left.length > 0) {
      console.warn(`NOT RESTORED — these tables are in the backup but not in this database:`);
      for (const [table, n] of left) console.warn(`  ${table.padEnd(20)} ${n} rows`);
    }

    const check = await compareToBackup(client as never, backup);
    if (check.ok) {
      console.log("Verified — every row matches the backup.");
    } else {
      console.error(`MISMATCH — ${check.differences.length} differences:`);
      for (const d of check.differences.slice(0, 20)) console.error(`  ${d}`);
      process.exitCode = 1;
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`Failed — nothing was changed. ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
