import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B } from "./helpers/pg";

/**
 * The restore, rehearsed.
 *
 * This product holds other people's customers' data on a database whose restore
 * had never been performed. A backup nobody has restored is not a backup — it
 * is a file, and the difference only becomes apparent on the day it matters.
 *
 * So this is not a test of a backup function. It is the rehearsal: real data
 * goes in, a backup is taken, the database is emptied, the backup goes back,
 * and every column of every row is compared. Counting rows would prove almost
 * nothing — the failure that matters is a value that came back subtly
 * different, and there are four of those below that a row count sails past.
 */

let db: TestDb;
let getPool: typeof import("../src/server/db").getPool;
let closePool: typeof import("../src/server/db").closePool;
let backup: typeof import("../src/server/backup");

beforeAll(async () => {
  db = await startTestDb();
  ({ getPool, closePool } = await import("../src/server/db"));
  backup = await import("../src/server/backup");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

/** Runs `fn` with a raw client, which is what backup and restore need. */
async function withClient<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

beforeEach(async () => {
  await db.seed(`
    DELETE FROM usage_events; DELETE FROM activities; DELETE FROM deals;
    DELETE FROM contacts; DELETE FROM companies;
  `);
});

/**
 * The values most likely to come back wrong.
 *
 * Each is here because it survives a row count and fails a real comparison:
 * a timestamp that shifts by a time zone, money that loses precision, JSON that
 * arrives as "[object Object]", and text that is not ASCII.
 */
async function seedAwkwardData() {
  await db.seed(`
    INSERT INTO companies (id, sub_account_id, name)
      VALUES ('co_1', '${TENANT_A}', 'Ünïcode & Co ''quoted''');

    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, phone, company_id, info, created_at)
      VALUES ('c_1', '${TENANT_A}', 'Ana', 'Silva', 'a@x.co', '+27 82 551 4470', 'co_1',
              'line one
line two', '2026-03-01T13:45:12.345Z'),
             ('c_2', '${TENANT_B}', 'Other', 'Tenant', NULL, NULL, NULL, NULL, now());

    INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage, pain_points, won_at)
      VALUES ('d_1', '${TENANT_A}', 'c_1', 'Retainer', 1234567, 'won',
              '["leads go cold", "no idea which ads pay"]'::jsonb,
              '2026-03-02T09:00:00.000Z'),
             ('d_2', '${TENANT_A}', 'c_1', 'Zero value', 0, 'prospect', '[]'::jsonb, NULL);

    INSERT INTO usage_events (id, sub_account_id, kind, quantity, cost_micros, detail, occurred_at)
      VALUES ('u_1', '${TENANT_A}', 'ai_message', 1.500, 9007199254740993,
              '{"model":"claude-sonnet-5","inputTokens":2000}'::jsonb,
              '2026-03-03T23:59:59.999Z');
  `);
}

describe("the round trip", () => {
  it("puts every row back, byte for byte", async () => {
    await seedAwkwardData();

    const taken = await withClient((c) => backup.takeBackup(c));
    expect(taken.manifest.rowCounts.contacts).toBe(2);
    expect(taken.manifest.rowCounts.deals).toBe(2);

    // Emptied and restored, which is the part that has never been done.
    const result = await withClient((c) => backup.restoreBackup(c, taken, { overwrite: true }));
    expect(result.restored.contacts).toBe(2);

    const check = await withClient((c) => backup.compareToBackup(c, taken));
    expect(check.differences, check.differences.join("\n")).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("PUTS THE AUDIT LOG BACK — an append-only table is still recoverable", async () => {
    /**
     * The audit log could be backed up and never restored, on two counts, and
     * neither showed up until the CLI was actually run: `audit_events.id` is
     * GENERATED ALWAYS, so Postgres refused the original key outright, and the
     * append-only trigger refused the wipe that precedes a restore.
     *
     * Both guards are right about live editing and wrong about recovery. A
     * table nobody can put back is not protected data, it is lost data with a
     * grace period. Found on 2026-09-30 running `db:backup` and then
     * `db:restore` against a real database for the first time.
     */
    await db.seed(`
      INSERT INTO contacts (id, sub_account_id, first_name, last_name)
        VALUES ('c_audit', '${TENANT_A}', 'Ana', 'Silva');
    `);
    await withClient((c) =>
      c.query(
        `INSERT INTO audit_events (sub_account_id, actor_name, action, entity, entity_id, detail)
         VALUES ($1, 'Demo Owner', 'update', 'contact', 'c_audit', 'Phone number')`,
        [TENANT_A]
      )
    );

    const taken = await withClient((c) => backup.takeBackup(c));
    expect(taken.manifest.rowCounts.audit_events).toBe(1);

    const result = await withClient((c) => backup.restoreBackup(c, taken, { overwrite: true }));
    expect(result.restored.audit_events, "the audit log did not come back").toBe(1);

    /* And with the same id, not a fresh one: an entry that changed its key on
       the way back is a different record claiming to be the same one. */
    const check = await withClient((c) => backup.compareToBackup(c, taken));
    expect(check.differences, check.differences.join("\n")).toEqual([]);
  });

  it("KEEPS A DATE ON THE DAY IT WAS — not a day earlier", async () => {
    /**
     * A DATE has no time and no time zone: it is the day a job starts or an
     * invoice falls due. `pg` parses one into a JavaScript Date, which is an
     * instant, so the 28th became midnight on the 28th in the server's zone,
     * was written to the file as "...27T22:00:00.000Z" and read back as the
     * 27th. Every due date in the backup moved a day earlier on the way home.
     *
     * The fixture above covers timestamps, money, JSON and unicode, and every
     * one of those was fine — which is exactly why this survived: no test
     * data had a DATE column in it.
     */
    await db.seed(`
      INSERT INTO contacts (id, sub_account_id, first_name, last_name)
        VALUES ('c_dates', '${TENANT_A}', 'Ana', 'Silva');
      INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage, starts_on, due_on)
        VALUES ('d_dates', '${TENANT_A}', 'c_dates', 'Dated', 1000, 'prospect',
                '2026-09-28', '2026-12-31');
    `);

    const taken = await withClient((c) => backup.takeBackup(c));
    const deal = taken.rows.deals.find((d) => d.id === "d_dates")!;
    /* In the file as the day itself, so it cannot be re-read in another zone
       and land somewhere else. */
    expect(deal.starts_on).toBe("2026-09-28");
    expect(deal.due_on).toBe("2026-12-31");

    await withClient((c) => backup.restoreBackup(c, taken, { overwrite: true }));
    const check = await withClient((c) => backup.compareToBackup(c, taken));
    expect(check.differences, check.differences.join("\n")).toEqual([]);

    const back = await withClient((c) =>
      c.query<{ starts_on: string }>(
        `SELECT to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM deals WHERE id = 'd_dates'`
      )
    );
    expect(back.rows[0].starts_on, "the day moved on the way back").toBe("2026-09-28");
  });

  it("leaves the append-only guard working once the restore is done", async () => {
    /* The triggers go back on. A restore that quietly left the audit log
       editable would trade one silent failure for a worse one. */
    const taken = await withClient((c) => backup.takeBackup(c));
    await withClient((c) => backup.restoreBackup(c, taken, { overwrite: true }));

    await expect(
      withClient(async (c) => {
        await c.query(
          `INSERT INTO audit_events (sub_account_id, action, entity) VALUES ($1, 'update', 'contact')`,
          [TENANT_A]
        );
        await c.query(`DELETE FROM audit_events`);
      })
    ).rejects.toThrow(/cannot be changed or removed/);
  });

  it("keeps a timestamp to the millisecond", async () => {
    /**
     * The failure a row count sails past. A timestamp that comes back an hour
     * out looks entirely plausible on screen, and every meeting in the account
     * is then at the wrong time — the same defect class as the migration's
     * host-dependent dates.
     */
    await seedAwkwardData();
    const taken = await withClient((c) => backup.takeBackup(c));
    await withClient((c) => backup.restoreBackup(c, taken, { overwrite: true }));

    const row = await withClient(async (c) =>
      (await c.query<{ created_at: Date }>(`SELECT created_at FROM contacts WHERE id = 'c_1'`)).rows[0]
    );
    expect(row.created_at.toISOString()).toBe("2026-03-01T13:45:12.345Z");
  });

  it("keeps JSON as JSON, not as a string of one", async () => {
    // `pg` sends a plain object as a record literal, which jsonb rejects — or
    // worse, a naive `String(value)` writes the text "[object Object]" and the
    // pain points on every deal are lost while the restore reports success.
    await seedAwkwardData();
    const taken = await withClient((c) => backup.takeBackup(c));
    await withClient((c) => backup.restoreBackup(c, taken, { overwrite: true }));

    const row = await withClient(async (c) =>
      (await c.query<{ pain_points: string[] }>(`SELECT pain_points FROM deals WHERE id = 'd_1'`)).rows[0]
    );
    expect(row.pain_points).toEqual(["leads go cold", "no idea which ads pay"]);
  });

  it("keeps a number too large for a JavaScript integer", async () => {
    /**
     * `cost_micros` is a BIGINT. 9007199254740993 is one past the largest
     * integer JavaScript can hold exactly — round-tripping it through a JS
     * number silently returns ...992. It is the shape of every currency bug
     * that gets found by an accountant rather than a test.
     */
    await seedAwkwardData();
    const taken = await withClient((c) => backup.takeBackup(c));
    await withClient((c) => backup.restoreBackup(c, taken, { overwrite: true }));

    const row = await withClient(async (c) =>
      (await c.query<{ cost_micros: string }>(`SELECT cost_micros FROM usage_events WHERE id = 'u_1'`)).rows[0]
    );
    expect(String(row.cost_micros), "a bigint lost precision in the round trip").toBe(
      "9007199254740993"
    );
  });

  it("keeps decimals, unicode, quotes and newlines", async () => {
    await seedAwkwardData();
    const taken = await withClient((c) => backup.takeBackup(c));
    await withClient((c) => backup.restoreBackup(c, taken, { overwrite: true }));

    const row = await withClient(async (c) =>
      (
        await c.query<{ name: string; info: string; quantity: string }>(
          `SELECT co.name, ct.info, u.quantity
             FROM companies co, contacts ct, usage_events u
            WHERE co.id = 'co_1' AND ct.id = 'c_1' AND u.id = 'u_1'`
        )
      ).rows[0]
    );
    expect(row.name).toBe("Ünïcode & Co 'quoted'");
    expect(row.info).toBe("line one\nline two");
    expect(String(row.quantity)).toBe("1.500");
  });

  it("keeps every workspace's rows apart", async () => {
    // An operational backup covers the whole database. Restoring it must not
    // merge two customers' records, which a restore keyed on anything but the
    // stored `sub_account_id` would do.
    await seedAwkwardData();
    const taken = await withClient((c) => backup.takeBackup(c));
    await withClient((c) => backup.restoreBackup(c, taken, { overwrite: true }));

    const counts = await withClient(async (c) =>
      (
        await c.query<{ a: string; b: string }>(
          `SELECT count(*) FILTER (WHERE sub_account_id = $1)::text AS a,
                  count(*) FILTER (WHERE sub_account_id = $2)::text AS b
             FROM contacts`,
          [TENANT_A, TENANT_B]
        )
      ).rows[0]
    );
    expect(counts.a).toBe("1");
    expect(counts.b).toBe("1");
  });
});

describe("the order tables are restored in", () => {
  it("puts every parent before its children", async () => {
    /**
     * Derived from the database's own constraints, not written down. A
     * hand-kept list falls behind the moment a table is added, and it fails as
     * a restore that stops halfway with a foreign key violation — precisely
     * when nobody wants to be debugging.
     */
    const order = await withClient((c) => backup.tableOrder(c));
    const at = (t: string) => order.indexOf(t);

    expect(at("agencies")).toBeLessThan(at("sub_accounts"));
    expect(at("sub_accounts")).toBeLessThan(at("contacts"));
    expect(at("contacts")).toBeLessThan(at("deals"));
    expect(at("companies")).toBeLessThan(at("contacts"));
    expect(at("users")).toBeLessThan(at("deals"));
  });

  it("covers every table in the database", async () => {
    const order = await withClient((c) => backup.tableOrder(c));
    const all = await withClient(async (c) =>
      (
        await c.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
        )
      ).rows.map((r) => r.table_name)
    );
    expect(order.length, "a table would be skipped by a backup").toBe(all.length);
    expect([...order].sort()).toEqual([...all].sort());
  });

  it("is stable, so two backups of one database are comparable", async () => {
    const a = await withClient((c) => backup.tableOrder(c));
    const b = await withClient((c) => backup.tableOrder(c));
    expect(a).toEqual(b);
  });
});

describe("a restore refuses to destroy what it was not asked to", () => {
  it("stops when the target already has rows", async () => {
    /**
     * The dangerous half is the wipe. A restore aimed at the wrong database —
     * production instead of the scratch copy — has to refuse rather than
     * quietly empty a live account.
     */
    await seedAwkwardData();
    const taken = await withClient((c) => backup.takeBackup(c));

    await expect(withClient((c) => backup.restoreBackup(c, taken))).rejects.toThrow(
      /already has .* rows/
    );

    // And it refused before deleting anything.
    const still = await withClient(async (c) =>
      (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM contacts`)).rows[0].n
    );
    expect(still, "the refusal happened after some rows were already deleted").toBe("2");
  });

  it("proceeds when overwriting is asked for explicitly", async () => {
    await seedAwkwardData();
    const taken = await withClient((c) => backup.takeBackup(c));
    await expect(
      withClient((c) => backup.restoreBackup(c, taken, { overwrite: true }))
    ).resolves.toBeTruthy();
  });
});

describe("the comparison can actually fail", () => {
  it("reports a row that came back different", async () => {
    /**
     * A verifier that cannot fail is the false green this whole exercise
     * exists to avoid — the migration's own verification was structurally
     * incapable of failing, and passed while it had migrated nothing.
     */
    await seedAwkwardData();
    const taken = await withClient((c) => backup.takeBackup(c));

    await db.seed(`UPDATE contacts SET first_name = 'Changed' WHERE id = 'c_1'`);

    const check = await withClient((c) => backup.compareToBackup(c, taken));
    expect(check.ok, "the comparison passed against altered data").toBe(false);
    expect(check.differences.join(" ")).toMatch(/first_name/);
  });

  it("notices a timestamp that moved by a millisecond", async () => {
    /**
     * The comparison IS the verifier, so its precision is the precision of the
     * whole rehearsal. Comparing dates by their day — or by anything that
     * rounds — would pass a backup whose timestamps had all shifted by an hour,
     * which is the failure most likely to happen and least likely to be seen.
     */
    await seedAwkwardData();
    const taken = await withClient((c) => backup.takeBackup(c));

    await db.seed(
      `UPDATE contacts SET created_at = '2026-03-01T13:45:12.346Z' WHERE id = 'c_1'`
    );

    const check = await withClient((c) => backup.compareToBackup(c, taken));
    expect(check.ok, "a one-millisecond drift went unnoticed").toBe(false);
    expect(check.differences.join(" ")).toMatch(/created_at/);
  });

  it("notices a value that changed without the row count changing", async () => {
    // Row counts are the reassuring number and the useless one. Every failure
    // that matters keeps the count identical.
    await seedAwkwardData();
    const taken = await withClient((c) => backup.takeBackup(c));
    await db.seed(`UPDATE deals SET value_cents = 1 WHERE id = 'd_1'`);

    const check = await withClient((c) => backup.compareToBackup(c, taken));
    expect(check.ok).toBe(false);
    expect(check.differences.join(" ")).toMatch(/value_cents/);
  });

  it("reports a missing row", async () => {
    await seedAwkwardData();
    const taken = await withClient((c) => backup.takeBackup(c));
    await db.seed(`DELETE FROM deals WHERE id = 'd_2'`);

    const check = await withClient((c) => backup.compareToBackup(c, taken));
    expect(check.ok).toBe(false);
    expect(check.differences.join(" ")).toMatch(/deals: 1 rows, expected 2/);
  });
});
