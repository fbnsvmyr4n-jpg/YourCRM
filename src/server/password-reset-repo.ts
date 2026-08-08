import { createHash, randomBytes } from "crypto";
import { mutateTable, readTable } from "./store";

const TABLE = "password_resets";

/**
 * Password reset tokens.
 *
 * Only a SHA-256 hash of each token is stored, never the token itself. If the
 * database is ever read by someone who shouldn't have it, the rows are useless
 * — the same reasoning that applies to passwords applies here, because a live
 * reset token *is* a credential.
 *
 * Tokens are single-use and short-lived, and a used or expired row is deleted
 * rather than flagged, so the table cannot grow without bound.
 */

const TTL_MS = 60 * 60 * 1000; // one hour

type ResetToken = {
  /** SHA-256 of the raw token. */
  hash: string;
  userId: string;
  email: string;
  expiresAt: number;
};

const seed: ResetToken[] = [];

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Issue a token for a user. Returns the raw token — the only time it exists in
 * plaintext. Any existing tokens for that user are dropped, so requesting a
 * new link immediately invalidates the previous one.
 */
export async function createResetToken(userId: string, email: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const now = Date.now();

  await mutateTable<ResetToken>(TABLE, seed, (rows) => {
    const kept = rows.filter((r) => r.userId !== userId && r.expiresAt > now);
    return [...kept, { hash: hashToken(raw), userId, email, expiresAt: now + TTL_MS }];
  });

  return raw;
}

/** Look up a token without consuming it — used to validate before showing the form. */
export async function peekResetToken(raw: string): Promise<{ userId: string; email: string } | null> {
  const rows = await readTable<ResetToken>(TABLE, seed);
  const hit = rows.find((r) => r.hash === hashToken(raw));
  if (!hit || hit.expiresAt <= Date.now()) return null;
  return { userId: hit.userId, email: hit.email };
}

/**
 * Consume a token. The lookup and the delete happen inside one mutate so the
 * same link cannot be redeemed twice by two concurrent requests — checking
 * first and deleting after is exactly the race an attacker would exploit.
 */
export async function consumeResetToken(raw: string): Promise<{ userId: string } | null> {
  const hash = hashToken(raw);
  const now = Date.now();
  let result: { userId: string } | null = null;

  await mutateTable<ResetToken>(TABLE, seed, (rows) => {
    const hit = rows.find((r) => r.hash === hash && r.expiresAt > now);
    if (!hit) return rows.filter((r) => r.expiresAt > now);
    result = { userId: hit.userId };
    return rows.filter((r) => r.hash !== hash && r.expiresAt > now);
  });

  return result;
}
