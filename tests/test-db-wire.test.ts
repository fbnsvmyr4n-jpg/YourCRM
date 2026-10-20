import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { startTestDb, type TestDb, TENANT_A } from "./helpers/pg";

/**
 * The test database speaks the wire protocol the way Postgres does.
 *
 * PGlite answers a failed parameterised statement with TWO ReadyForQuery
 * messages — one straight after the error, one for the Sync — where Postgres
 * sends one. `pg` matches replies to queries by those messages, so the spare
 * one shifted every later reply onto the wrong query, but only when it arrived
 * in a read of its own: the `tags.test.ts` flake, about one run in two, and
 * the reason `helpers/pg.ts` and `scripts/dev-db.ts` both filter it out (see
 * `oneReadyForQueryPerSync` in `scripts/pglite-wire.ts`).
 *
 * Asserted on raw bytes over a raw socket, not through `pg`, because through
 * `pg` the defect is a coin toss and this needs to fail every time it is back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await startTestDb();
});
afterAll(async () => {
  await db.stop();
});

const message = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(5);
  head.write(type, 0);
  head.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([head, body]);
};
const cstr = (s: string) => Buffer.from(`${s}\0`);
const int16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};

/**
 * ParameterStatus, NoticeResponse, NotificationResponse: the protocol lets the
 * server send these at any moment, and PGlite re-reports its parameters after a
 * failed implicit transaction. They are not replies to anything, so they are
 * not counted.
 */
const ASYNCHRONOUS = new Set(["S", "N", "A"]);

/** Reply message types received, in order, until `done` says the stream is complete. */
function readTypes(socket: Socket, done: (types: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    let types = "";
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5 && pending.length >= 1 + pending.readInt32BE(1)) {
        const type = String.fromCharCode(pending[0]);
        if (!ASYNCHRONOUS.has(type)) types += type;
        pending = pending.subarray(1 + pending.readInt32BE(1));
      }
      if (done(types)) {
        socket.off("data", onData);
        resolve(types);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

describe("the test database's wire protocol", () => {
  it("SENDS ONE ReadyForQuery FOR A FAILED STATEMENT, not one for the error and another for the Sync", async () => {
    const socket = connect(db.port, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));

      const startup = Buffer.concat([int32(196608), cstr("user"), cstr("postgres"), cstr("database"), cstr("postgres"), Buffer.from([0])]);
      const ready = readTypes(socket, (t) => t.endsWith("Z"));
      socket.write(Buffer.concat([int32(4 + startup.length), startup]));
      await ready;

      // A duplicate primary key, parameterised: Parse, Bind, Describe, Execute, Sync —
      // then a plain query on the same connection, as `q.attempt` would send its rollback.
      const insert = "INSERT INTO sub_accounts (id, agency_id, name, is_primary) SELECT $1, agency_id, 'dup', FALSE FROM sub_accounts WHERE id = $1";
      const reply = readTypes(socket, (t) => t.endsWith("CZ"));
      socket.write(
        Buffer.concat([
          message("P", cstr(""), cstr(insert), int16(0)),
          message("B", cstr(""), cstr(""), int16(0), int16(1), int32(TENANT_A.length), Buffer.from(TENANT_A), int16(0)),
          message("D", Buffer.from("P"), cstr("")),
          message("E", cstr(""), int32(0)),
          message("S"),
          message("Q", cstr("SELECT 1")),
        ])
      );

      // ParseComplete, BindComplete, NoData, Error, ReadyForQuery — then the SELECT's own
      // RowDescription, DataRow, CommandComplete, ReadyForQuery. A second Z after the E is the bug.
      expect(await reply).toBe("12nEZTDCZ");
    } finally {
      socket.destroy();
    }
  });
});
