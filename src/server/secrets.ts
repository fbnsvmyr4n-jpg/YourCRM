import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Secrets a workspace gives us to act on its behalf — a Paystack secret key —
 * encrypted before they touch the database.
 *
 * AES-256-GCM, so a tampered value fails to decrypt rather than decrypting to
 * something else. The key is derived from `AUTH_SECRET` with HKDF under a label
 * of its own: no new environment variable to forget, and a different key from
 * the one that signs sessions even though both start from the same secret.
 *
 * The stored form names its version (`v1:`) so the scheme can change without
 * guessing what an old value is. Rotating `AUTH_SECRET` makes stored secrets
 * unreadable; the Settings screen then says the connection needs its key again,
 * which is the honest outcome — never a silent failure to take payment.
 *
 * Nothing here logs, and nothing returns a secret to a browser. The only thing a
 * screen ever sees is the last four characters, kept separately.
 */

const LABEL = "yourcrm:workspace-secrets:v1";

function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET is not set, so secrets cannot be stored");
  return Buffer.from(hkdfSync("sha256", secret, LABEL, "aes-256-gcm", 32));
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

/** Null when the value cannot be read — tampered, or written under a secret since rotated. */
export function decryptSecret(stored: string): string | null {
  const [version, iv, tag, body] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
