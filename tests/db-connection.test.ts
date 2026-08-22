import { describe, expect, it } from "vitest";
import { isLocal } from "../src/server/db";

/**
 * Whether a connection gets TLS.
 *
 * This was decided by `connectionString.includes("localhost")`, which is wrong
 * in both directions. It said no to the local dev database at 127.0.0.1 —
 * surfacing as "the server does not support SSL connections", which reads like
 * a database fault rather than a client assumption — and it would say yes to
 * any hosted name that happens to contain the word.
 *
 * The second direction is the one that matters: getting it wrong there means a
 * production connection carrying customer records in plain text.
 */

describe("TLS is decided by the host, not by a substring", () => {
  it("skips TLS for a loopback database, however it is written", () => {
    for (const url of [
      "postgresql://postgres:postgres@localhost:5433/postgres",
      "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
      "postgresql://u:p@[::1]:5432/db",
    ]) {
      expect(isLocal(url), `${url} was treated as remote`).toBe(true);
    }
  });

  it("requires TLS for anything hosted", () => {
    for (const url of [
      "postgresql://u:p@ep-example-host.us-east-2.aws.neon.tech/neondb?sslmode=require",
      "postgresql://u:p@db.supabase.co:5432/postgres",
      "postgresql://u:p@10.0.0.5:5432/postgres",
      // The substring trap, in the direction that leaks: a real remote host
      // whose name contains the word would have connected in plain text.
      "postgresql://u:p@localhost.evil.example.com:5432/postgres",
      "postgresql://u:p@my-localhost-proxy.aws.com:5432/postgres",
    ]) {
      expect(isLocal(url), `${url} was treated as local — it would connect without TLS`).toBe(false);
    }
  });

  it("assumes TLS when it cannot tell", () => {
    // An unparseable string is not something to guess about. The worst case of
    // assuming TLS is a clear handshake error; the worst case of assuming local
    // is customer data crossing a network unencrypted.
    for (const url of ["", "not a url", "postgres://"]) {
      expect(isLocal(url)).toBe(false);
    }
  });
});
