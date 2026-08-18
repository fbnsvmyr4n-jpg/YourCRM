import { createHash, randomBytes } from "node:crypto";
import type { SystemQuery } from "../tenant";

/**
 * Pre-authentication infrastructure: reset tokens and login rate limiting.
 *
 * Takes a `SystemQuery`, not a tenant one, because both of these run for
 * somebody who is not signed in — rate limiting a login has to work before the
 * account is even identified. Neither touches customer records; a row here is a
 * hash or a counter.
 *
 * Ported from the file-store versions, whose security design was already right
 * and is kept exactly: hashes not tokens, single-use, short-lived, two
 * independent limits.
 */

// --- Password reset ---------------------------------------------------------

const TTL_MS = 60 * 60 * 1000; // one hour

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Issue a token. Returns the raw value — the only moment it exists in plaintext.
 *
 * Only the SHA-256 hash is stored. A live reset token *is* a credential, so the
 * rule that applies to passwords applies here: if this table leaks, the rows
 * must be useless to whoever reads them.
 *
 * Any existing token for the user is dropped first, so asking for a new link
 * immediately invalidates the previous one — otherwise every request leaves
 * another working key to the account lying around for an hour.
 */
export async function createResetToken(
  q: SystemQuery,
  userId: string,
  email: string
): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await q.rows(`DELETE FROM password_resets WHERE user_id = $1`, [userId]);
  await q.rows(
    `INSERT INTO password_resets (token_hash, user_id, email, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
    [hashToken(raw), userId, email, String(TTL_MS)]
  );
  return raw;
}

/** Look a token up without spending it — for showing the reset form. */
export async function peekResetToken(
  q: SystemQuery,
  raw: string
): Promise<{ userId: string; email: string } | null> {
  const row = await q.one<{ user_id: string; email: string }>(
    `SELECT user_id, email FROM password_resets
     WHERE token_hash = $1 AND expires_at > now()`,
    [hashToken(raw)]
  );
  return row ? { userId: row.user_id, email: row.email } : null;
}

/**
 * Spend a token: verify and delete in one statement.
 *
 * `DELETE ... RETURNING` rather than select-then-delete, so two submissions of
 * the same link cannot both succeed. Only one of them can delete the row, and
 * the other gets nothing — the check and the consumption are the same
 * operation, which is the only way a single-use token is actually single-use.
 */
export async function consumeResetToken(
  q: SystemQuery,
  raw: string
): Promise<{ userId: string } | null> {
  const row = await q.one<{ user_id: string }>(
    `DELETE FROM password_resets
     WHERE token_hash = $1 AND expires_at > now()
     RETURNING user_id`,
    [hashToken(raw)]
  );
  return row ? { userId: row.user_id } : null;
}

/** Housekeeping: expired rows are useless and should not accumulate. */
export async function purgeExpiredResets(q: SystemQuery): Promise<number> {
  const rows = await q.rows<{ token_hash: string }>(
    `DELETE FROM password_resets WHERE expires_at <= now() RETURNING token_hash`
  );
  return rows.length;
}

// --- Login rate limiting ----------------------------------------------------

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 20;
/**
 * Signups are counted whether they succeed or not: the abuse there is volume,
 * not guessing, so a run of *successful* creations is the thing to stop.
 */
const MAX_SIGNUPS_PER_IP = 5;

/** The prefix keeps the namespaces apart, so an email cannot be passed off as an IP. */
export const emailKey = (email: string) => `email:${email.trim().toLowerCase()}`;
export const ipKey = (ip: string) => `ip:${ip}`;
export const signupKey = (ip: string) => `signup:${ip}`;

function limitFor(key: string): number {
  if (key.startsWith("email:")) return MAX_PER_EMAIL;
  if (key.startsWith("signup:")) return MAX_SIGNUPS_PER_IP;
  return MAX_PER_IP;
}

export type RateVerdict = { allowed: true } | { allowed: false; retryAfterSec: number };

/**
 * Is any of these keys locked out right now?
 *
 * Two independent limits, checked together: per email stops guessing at one
 * known account, per IP stops spraying one password across many accounts —
 * which the per-email limit alone would never notice, because no single account
 * accumulates failures.
 */
export async function checkLoginRate(q: SystemQuery, keys: string[]): Promise<RateVerdict> {
  if (keys.length === 0) return { allowed: true };
  const row = await q.one<{ retry_after: string }>(
    `SELECT CEIL(EXTRACT(EPOCH FROM (MAX(locked_until) - now())))::text AS retry_after
     FROM login_attempts
     WHERE key = ANY($1) AND locked_until IS NOT NULL AND locked_until > now()`,
    [keys]
  );
  const retry = row?.retry_after ? Number(row.retry_after) : 0;
  return retry > 0 ? { allowed: false, retryAfterSec: retry } : { allowed: true };
}

/**
 * Record a failure against every key, locking any that crosses its limit.
 *
 * One statement per key, done as an upsert, so the increment happens inside the
 * database rather than as read-then-write. Concurrent guesses are exactly the
 * situation this defends against, and a read-modify-write counter would lose
 * increments precisely when it is under attack — which is the only time it
 * matters.
 *
 * The window resets itself: if the first failure is older than WINDOW_MS the
 * counter starts again at one, so an honest user who mistyped a password twice
 * last week is not one attempt away from a lockout.
 */
export async function registerFailedLogin(q: SystemQuery, keys: string[]): Promise<void> {
  for (const key of keys) {
    await q.rows(
      `INSERT INTO login_attempts (key, failures, first_at)
       VALUES ($1, 1, now())
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE
           WHEN login_attempts.first_at < now() - ($2 || ' milliseconds')::interval THEN 1
           ELSE login_attempts.failures + 1
         END,
         first_at = CASE
           WHEN login_attempts.first_at < now() - ($2 || ' milliseconds')::interval THEN now()
           ELSE login_attempts.first_at
         END,
         locked_until = CASE
           WHEN login_attempts.first_at >= now() - ($2 || ' milliseconds')::interval
            AND login_attempts.failures + 1 >= $3
           THEN now() + ($4 || ' milliseconds')::interval
           ELSE login_attempts.locked_until
         END`,
      [key, String(WINDOW_MS), limitFor(key), String(LOCK_MS)]
    );
  }
}

/** Clear on success, so a legitimate sign-in wipes the slate for that account. */
export async function clearLoginRate(q: SystemQuery, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await q.rows(`DELETE FROM login_attempts WHERE key = ANY($1)`, [keys]);
}

/** Counters for a key, for tests and for showing a user why they are locked out. */
export async function loginAttemptState(
  q: SystemQuery,
  key: string
): Promise<{ failures: number; lockedUntil: string | null } | null> {
  const row = await q.one<{ failures: number; locked_until: Date | null }>(
    `SELECT failures, locked_until FROM login_attempts WHERE key = $1`,
    [key]
  );
  if (!row) return null;
  return {
    failures: row.failures,
    lockedUntil: row.locked_until ? row.locked_until.toISOString() : null,
  };
}
