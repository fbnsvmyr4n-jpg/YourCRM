import type { PoolClient } from "pg";

/**
 * Taking a copy of the database, and putting it back.
 *
 * This product holds other people's customers' data. A backup nobody has ever
 * restored is not a backup — it is a file, and the difference only becomes
 * apparent on the day it matters. So the round trip is exercised by a test that
 * genuinely backs up, wipes, restores and compares, rather than by anybody's
 * confidence that it would work.
 *
 * Deliberately data-only. The schema is `schema.sql`, applied by `db:migrate`,
 * and a restore into an empty database is "migrate, then restore" — two steps
 * that are each already proven, rather than one that duplicates the schema in a
 * second place and lets the two drift.
 */

export type BackupManifest = {
  takenAt: string;
  /** Table order, already safe to restore in. */
  tables: string[];
  rowCounts: Record<string, number>;
};

export type Backup = {
  manifest: BackupManifest;
  rows: Record<string, Record<string, unknown>[]>;
};

/**
 * Tables in an order that satisfies the foreign keys.
 *
 * Derived from the database's own constraints rather than written down. A
 * hand-kept list is a second source of truth that falls behind the moment a
 * table is added — and the way it fails is a restore that stops halfway with a
 * foreign key violation, which is exactly when nobody wants to be debugging.
 */
export async function tableOrder(client: PoolClient): Promise<string[]> {
  const { rows: tables } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );

  const { rows: deps } = await client.query<{ child: string; parent: string }>(
    `SELECT c.relname AS child, p.relname AS parent
       FROM pg_constraint fk
       JOIN pg_class c ON c.oid = fk.conrelid
       JOIN pg_class p ON p.oid = fk.confrelid
      WHERE fk.contype = 'f'`
  );

  const names = tables.map((t) => t.table_name);
  const parents = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  for (const d of deps) {
    // A self-reference is not a dependency between tables — including it would
    // make the graph unsortable and the whole backup unusable.
    if (d.child === d.parent) continue;
    parents.get(d.child)?.add(d.parent);
  }

  const out: string[] = [];
  const placed = new Set<string>();

  // Kahn's algorithm, alphabetical within a level so the order is stable and
  // two backups of the same database are comparable.
  while (out.length < names.length) {
    const ready = names
      .filter((n) => !placed.has(n))
      .filter((n) => [...(parents.get(n) ?? [])].every((p) => placed.has(p) || !names.includes(p)))
      .sort();

    if (ready.length === 0) {
      // A genuine cycle. Fail loudly rather than emitting an order that will
      // break on restore — a backup that cannot be restored is worse than a
      // failed backup, because nobody finds out until they need it.
      const stuck = names.filter((n) => !placed.has(n));
      throw new Error(`Cannot order tables for restore; a foreign key cycle involves: ${stuck.join(", ")}`);
    }

    for (const n of ready) {
      out.push(n);
      placed.add(n);
    }
  }

  return out;
}

/** Read every row of every table. */
export async function takeBackup(client: PoolClient): Promise<Backup> {
  const tables = await tableOrder(client);
  const rows: Record<string, Record<string, unknown>[]> = {};
  const rowCounts: Record<string, number> = {};

  for (const table of tables) {
    /**
     * Ordered by the whole row, cast to text.
     *
     * `ORDER BY 1` orders by the FIRST column only, which is not deterministic
     * for a table whose key is composite — `plan_entitlements` is keyed on
     * (plan, feature), so its rows came back in an arbitrary order within each
     * plan. Two backups of an unchanged database then differed, and the
     * verification reported mismatches that were really just a reshuffle.
     *
     * Found by rehearsing against real data, where a table with a composite key
     * actually had rows in it.
     */
    const { rows: data } = await client.query(
      `SELECT * FROM ${quote(table)} ORDER BY ${quote(table)}::text`
    );
    rows[table] = data;
    rowCounts[table] = data.length;
  }

  return {
    manifest: { takenAt: new Date().toISOString(), tables, rowCounts },
    rows,
  };
}

/**
 * Put a backup back.
 *
 * Wipes first, in reverse dependency order, then inserts in forward order. The
 * wipe is the dangerous half, which is why `expectEmpty` defaults to true: a
 * restore aimed at the wrong database should refuse rather than quietly delete
 * a live one.
 */
export async function restoreBackup(
  client: PoolClient,
  backup: Backup,
  opts: { overwrite?: boolean } = {}
): Promise<{ restored: Record<string, number>; skipped: Record<string, number> }> {
  const order = await tableOrder(client);

  /**
   * Tables in the backup that this database does not have.
   *
   * Found by rehearsing: production still holds `crm_collections`, the retired
   * JSONB table, and `schema.sql` deliberately no longer creates it. So a
   * restore into a freshly migrated database died on a table nobody wanted
   * back.
   *
   * Reported rather than ignored. Silently dropping rows is how a restore
   * "succeeds" while leaving data behind — but failing outright would make
   * every backup taken before a table was retired unusable, which is worse.
   * The caller is told exactly what was left and how much of it.
   */
  const present = new Set(order);
  const skipped: Record<string, number> = {};
  for (const table of backup.manifest.tables) {
    if (!present.has(table)) skipped[table] = (backup.rows[table] ?? []).length;
  }

  if (!opts.overwrite) {
    for (const table of order) {
      // `plan_entitlements` is seeded by `schema.sql` itself — the published
      // price list, identical for every deployment. So a freshly migrated
      // database is never actually empty, and without this the documented
      // recovery path ("migrate, then restore") always trips the guard. People
      // would learn to pass `overwrite` reflexively, which is exactly how the
      // protection stops protecting anything.
      //
      // Found by rehearsing the restore rather than by reading it.
      if (table === "plan_entitlements") continue;
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${quote(table)}`
      );
      if (Number(rows[0].n) > 0) {
        throw new Error(
          `${table} already has ${rows[0].n} rows. Restoring would delete them — pass overwrite to do that deliberately.`
        );
      }
    }
  }

  /**
   * Children first, so nothing is deleted while something still points at it.
   *
   * No test distinguishes this from the forward order today, and that is worth
   * saying plainly: every foreign key in this schema cascades or nulls, so
   * deleting the parents first empties the children anyway. The reverse order
   * is kept because that stops being true the moment one constraint is added
   * without a cascade — and the failure then is a restore that dies halfway.
   */
  for (const table of [...order].reverse()) {
    await client.query(`DELETE FROM ${quote(table)}`);
  }

  const restored: Record<string, number> = {};

  for (const table of order) {
    const data = backup.rows[table] ?? [];
    restored[table] = 0;
    if (data.length === 0) continue;

    // Columns from the backup, not from the live table: a column added since
    // the backup was taken has no value to restore, and naming it would insert
    // undefined rather than letting the default apply.
    const columns = Object.keys(data[0]);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${placeholders})`;

    for (const row of data) {
      await client.query(
        sql,
        columns.map((c) => {
          const v = row[c];
          // `pg` sends a plain object as a record literal, which a jsonb column
          // rejects. Serialised here so JSONB survives the round trip — the
          // pain points on a deal live in one.
          if (v !== null && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
            return JSON.stringify(v);
          }
          return v;
        })
      );
      restored[table]++;
    }
  }

  return { restored, skipped };
}

/**
 * Compare a backup against a database, table by table and row by row.
 *
 * The thing that makes a rehearsal a rehearsal. Counting rows proves almost
 * nothing — the failure that matters is a column that came back subtly
 * different: a timestamp shifted by a time zone, money that lost its precision,
 * a JSON field that arrived as the string "[object Object]".
 */
export async function compareToBackup(
  client: PoolClient,
  backup: Backup
): Promise<{ ok: boolean; differences: string[] }> {
  const differences: string[] = [];

  const order = await tableOrder(client);
  const present = new Set(order);

  for (const table of backup.manifest.tables) {
    // A table this database does not have was reported as skipped by the
    // restore; comparing it would fail on a difference nobody can act on.
    if (!present.has(table)) continue;
    // The same total order the backup was written in; see `takeBackup`.
    const { rows } = await client.query(
      `SELECT * FROM ${quote(table)} ORDER BY ${quote(table)}::text`
    );
    const expected = backup.rows[table] ?? [];

    if (rows.length !== expected.length) {
      differences.push(`${table}: ${rows.length} rows, expected ${expected.length}`);
      continue;
    }

    for (let i = 0; i < expected.length; i++) {
      for (const column of Object.keys(expected[i])) {
        const a = normalise(expected[i][column]);
        const b = normalise(rows[i][column]);
        if (a !== b) {
          differences.push(`${table}[${i}].${column}: ${b} — expected ${a}`);
        }
      }
    }
  }

  return { ok: differences.length === 0, differences };
}

/** One comparable form for values pg returns in several shapes. */
function normalise(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  // A timestamp comes back as a Date; comparing them by reference or by
  // `toString` loses milliseconds, which is precisely where a silent drift of
  // an hour would hide.
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Identifier quoting. Table names here come from the database itself, but a
 *  string interpolated into SQL is a habit worth never having. */
function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
