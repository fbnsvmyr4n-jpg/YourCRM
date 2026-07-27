import { mutateTable, readTable } from "./store";

const TABLE = "login_attempts";

/**
 * Brute-force protection for sign-in.
 *
 * Without this the app accepts unlimited password guesses — verified against
 * the live deployment: twelve consecutive attempts, all processed, no delay.
 * That matters more than usual here because the seeded account's *username*
 * is published in the README, so only the password stands in the way.
 *
 * State is persisted rather than held in memory: on a serverless host each
 * request may land on a fresh instance, so an in-process counter would reset
 * constantly and protect nothing.
 *
 * Two independent limits:
 *   • per email — stops guessing at one known account
 *   • per IP    — stops spraying one password across many accounts, which the
 *                 per-email limit alone would never notice
 */

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 20;
/** Signups are counted whether they succeed or not — the abuse here is volume,
 *  not guessing, so a run of *successful* creations is the thing to stop. */
const MAX_SIGNUPS_PER_IP = 5;

type Attempt = {
  /** `email:someone@x.com` or `ip:1.2.3.4` — the prefix keeps the two spaces apart. */
  key: string;
  failures: number;
  /** When the current window opened. */
  firstAt: number;
  /** Epoch ms until which this key is locked out, if it is. */
  lockedUntil?: number;
};

const seed: Attempt[] = [];

export type RateVerdict = { allowed: true } | { allowed: false; retryAfterSec: number };

export function emailKey(email: string) {
  return `email:${email.trim().toLowerCase()}`;
}
export function ipKey(ip: string) {
  return `ip:${ip}`;
}
export function signupKey(ip: string) {
  return `signup:${ip}`;
}

function limitFor(key: string) {
  if (key.startsWith("signup:")) return MAX_SIGNUPS_PER_IP;
  if (key.startsWith("ip:")) return MAX_PER_IP;
  return MAX_PER_EMAIL;
}

/** Drop entries that are no longer doing anything, so the table can't grow forever. */
function prune(rows: Attempt[], now: number): Attempt[] {
  return rows.filter(
    (r) => (r.lockedUntil && r.lockedUntil > now) || now - r.firstAt < WINDOW_MS
  );
}

/**
 * Is this attempt allowed? Read-only — call before verifying the password so a
 * locked-out attacker never reaches the (deliberately expensive) hash check.
 */
export async function checkLoginRate(keys: string[]): Promise<RateVerdict> {
  const now = Date.now();
  const rows = await readTable<Attempt>(TABLE, seed);

  let longest = 0;
  for (const key of keys) {
    const row = rows.find((r) => r.key === key);
    if (row?.lockedUntil && row.lockedUntil > now) {
      longest = Math.max(longest, row.lockedUntil - now);
    }
  }
  return longest > 0
    ? { allowed: false, retryAfterSec: Math.ceil(longest / 1000) }
    : { allowed: true };
}

/**
 * Record a failed attempt against every key, locking any that cross their
 * limit. The read, the increment and the write all happen inside one
 * `mutateTable` call — checking first and writing after would let concurrent
 * attempts slip past the threshold, which is exactly the pattern an attacker
 * would exploit by firing requests in parallel.
 */
export async function registerFailedLogin(keys: string[]): Promise<void> {
  const now = Date.now();
  await mutateTable<Attempt>(TABLE, seed, (rows) => {
    const next = prune(rows, now);

    for (const key of keys) {
      const idx = next.findIndex((r) => r.key === key);
      const current = idx === -1 ? undefined : next[idx];

      // A window that has aged out starts over rather than accumulating
      // failures from hours ago.
      const windowExpired = current ? now - current.firstAt >= WINDOW_MS : true;
      const failures = current && !windowExpired ? current.failures + 1 : 1;
      const firstAt = current && !windowExpired ? current.firstAt : now;

      const entry: Attempt = {
        key,
        failures,
        firstAt,
        lockedUntil: failures >= limitFor(key) ? now + LOCK_MS : current?.lockedUntil,
      };

      if (idx === -1) next.push(entry);
      else next[idx] = entry;
    }
    return next;
  });
}

/** A correct password clears the record — legitimate users aren't punished for typos. */
export async function clearLoginRate(keys: string[]): Promise<void> {
  const now = Date.now();
  await mutateTable<Attempt>(TABLE, seed, (rows) => {
    const filtered = rows.filter((r) => !keys.includes(r.key));
    return filtered.length === rows.length ? rows : prune(filtered, now);
  });
}
