import type { PGlite } from "@electric-sql/pglite";

/**
 * Wire-protocol repairs for PGlite served over `PGLiteSocketServer`.
 *
 * Shared by the two places that serve PGlite to the real `pg` driver — the
 * test harness (`tests/helpers/pg.ts`) and the local dev database
 * (`scripts/dev-db.ts`) — so the fix cannot be applied to one and drift in the
 * other. The test harness found the defect; the dev database serves PGlite the
 * same way, so a duplicate tag or saved-view name typed into the running app
 * could wedge its connection just as it wedged the tests. Production runs on
 * real Postgres and needs none of this.
 */

/** Parse, Bind, Describe, Execute, Close, Flush — the extended-query messages. */
const EXTENDED_QUERY = new Set([..."PBDECH"].map((c) => c.charCodeAt(0)));
const READY_FOR_QUERY = "Z".charCodeAt(0);

/**
 * ONE ReadyForQuery per Sync, which is what the protocol promises and what
 * PGlite does not deliver.
 *
 * When a parameterised statement fails — a duplicate name, a trigger refusing
 * a row — Postgres sends ErrorResponse, discards everything up to the client's
 * Sync, and answers the Sync with a single ReadyForQuery. PGlite (0.5.8, and
 * still 0.5.10) sends a ReadyForQuery straight after the error AND another for
 * the Sync. Probed directly, a duplicate INSERT answers `12nE Z Z` where
 * Postgres answers `12nE Z`.
 *
 * `pg` treats the first Z as the end of the failed query and sends the next
 * one — in `q.attempt` that is `ROLLBACK TO SAVEPOINT`. If the stray second Z
 * arrives in a separate read, which depends on nothing but timing, it is taken
 * as the end of THAT statement, and from then on every reply is matched to the
 * query before it: `Received unexpected parseComplete message from backend`,
 * then `Client has encountered a connection error and is not queryable`.
 *
 * That was the `tags.test.ts` flake — about half its runs on its own, rarer in
 * the full suite where the timing differs — and it was blamed on the refused
 * statement leaving the transaction aborted, which it does not: the savepoint
 * works, and the same failure appeared in a test with no refusal in it, because
 * the desync outlives the test that caused it. A wire trace showed the double
 * Z; nothing else did.
 *
 * ReadyForQuery only ever answers a Query or a Sync, so it is dropped from the
 * reply to any extended-query message.
 *
 * Call it AFTER any in-process setup (`db.exec`, `db.query`) and BEFORE the
 * socket server starts. It replaces `execProtocolRawStream`, which is the
 * socket server's only way in; PGlite's own `query` takes a different path, so
 * in-process calls are unaffected either way — but applying it last keeps that
 * a fact about the order rather than about PGlite's internals, and makes the
 * socket server the only caller it can change. `tests/test-db-wire.test.ts`
 * asserts the result on raw bytes, and fails every time this is missing.
 */
export function oneReadyForQueryPerSync(db: PGlite): void {
  const raw = db.execProtocolRawStream.bind(db);
  db.execProtocolRawStream = async (message, options) => {
    if (!options || !EXTENDED_QUERY.has(message[0])) return raw(message, options);
    const chunks: Buffer[] = [];
    // Copied: the bytes handed out may be a view onto memory PGlite reuses.
    await raw(message, { ...options, onRawData: (data) => chunks.push(Buffer.from(data)) });
    const reply = Buffer.concat(chunks);
    const kept: Buffer[] = [];
    for (let at = 0; at < reply.length; ) {
      const end = at + 1 + reply.readInt32BE(at + 1);
      if (reply[at] !== READY_FOR_QUERY) kept.push(reply.subarray(at, end));
      at = end;
    }
    if (kept.length) options.onRawData(Buffer.concat(kept));
  };
}
