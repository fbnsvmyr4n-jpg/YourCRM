import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";

/**
 * Minimal, dependency-free auth primitives.
 *
 * - Passwords: scrypt with a per-user random salt (never stored in plain text).
 * - Sessions: a signed token `userId.expiry.hmac` stored in an httpOnly cookie.
 *
 * The signing secret comes from AUTH_SECRET. Locally a fixed dev fallback is
 * used so the app runs with no setup — but that fallback is **in this file**,
 * so anyone who can read the source can forge a session cookie for any user id
 * and sign in as them without a password. Verified: that is a complete auth
 * bypass, and it is silent — the app looks perfectly healthy.
 *
 * So in production the fallback is refused outright. Failing to boot is a far
 * better outcome than serving an app whose sessions anyone can mint.
 */

const DEV_FALLBACK_SECRET = "yourcrm-dev-secret-change-me";
const MIN_SECRET_LENGTH = 16;

export const SESSION_COOKIE = "yourcrm_session";
const SESSION_DAYS = 30;

/**
 * Resolved per call rather than at module load: `next build` evaluates modules
 * without the runtime environment, and refusing to build is not the goal —
 * refusing to *serve* unsigned-safe sessions is.
 */
function sessionSecret(): string {
  const configured = process.env.AUTH_SECRET?.trim();
  const isProduction = process.env.NODE_ENV === "production";

  if (configured && configured.length >= MIN_SECRET_LENGTH && configured !== DEV_FALLBACK_SECRET) {
    return configured;
  }

  if (isProduction) {
    throw new Error(
      "AUTH_SECRET is missing, too short, or still the dev default. " +
        "Session cookies would be forgeable by anyone who can read the source. " +
        "Set AUTH_SECRET to at least 16 random characters — generate one with: openssl rand -base64 32"
    );
  }

  return configured && configured.length >= MIN_SECRET_LENGTH ? configured : DEV_FALLBACK_SECRET;
}

/** Whether the signing secret is safe to serve with. Surfaced in Settings. */
export function authSecretConfigured(): boolean {
  const configured = process.env.AUTH_SECRET?.trim();
  return Boolean(
    configured && configured.length >= MIN_SECRET_LENGTH && configured !== DEV_FALLBACK_SECRET
  );
}

/* ---------------- passwords ---------------- */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, 64);
  const known = Buffer.from(hash, "hex");
  if (known.length !== derived.length) return false;
  return timingSafeEqual(known, derived);
}

/* ---------------- sessions ---------------- */

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

export function createSessionToken(userId: string): string {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${userId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns the userId if the token is well-formed, unexpired and correctly signed. */
export function readSessionToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expires, sig] = parts;
  const expected = sign(`${userId}.${expires}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expires) < Date.now()) return null;
  return userId;
}

export const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;
