/**
 * Structured logging.
 *
 * Before this existed the entire codebase contained **one** `console.info` in
 * 20,494 lines. Nothing recorded who signed in, what was written, or what was
 * deleted — so a breach or a data-loss incident would have been both
 * undetectable and unreconstructable. The audit rated 11 of 15 registered risks
 * "silent" for this reason alone.
 *
 * Single-line JSON on stdout, deliberately: Vercel, Fly, Railway and Docker all
 * capture stdout without configuration, so this needs no transport, no vendor
 * and no key to start working. A hosted log service can consume the same lines
 * later without changing a call site.
 *
 * **What is never logged:** passwords, password hashes, session tokens, reset
 * tokens, API keys, or the contents of any CRM record. An audit trail needs to
 * say *who did what to which record* — it does not need the record's data, and
 * storing that turns the log itself into a breach target.
 */

type Level = "info" | "warn" | "error";

/** Field names that must never reach the log, whatever a caller passes. */
const REDACT = /password|passwordhash|token|secret|apikey|api_key|authorization|cookie/i;

function safe(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (REDACT.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    // Objects are not spread into the log: a caller passing a whole record
    // would otherwise leak its contents through a field nobody named.
    out[k] = typeof v === "object" && v !== null ? "[object]" : v;
  }
  return out;
}

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...safe(fields),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/**
 * A sign-in, sign-up, sign-out or a refusal.
 *
 * `email` is included here and nowhere else. A failed-login record is
 * unusable for spotting an attack without knowing which account was targeted,
 * which is the one place that outweighs keeping the address out of the log.
 */
export function logAuth(
  event: "signin.ok" | "signin.failed" | "signup.ok" | "signup.failed" | "signout" | "ratelimited",
  fields: { email?: string; userId?: string; reason?: string } = {}
): void {
  emit(event.endsWith(".failed") || event === "ratelimited" ? "warn" : "info", `auth.${event}`, fields);
}

/**
 * An authenticated caller changed stored data.
 *
 * `entity` and `id` identify the record; the new values are deliberately absent.
 */
export function logWrite(
  action: "create" | "update" | "delete",
  entity: string,
  fields: { id?: string; actor?: string; detail?: string } = {}
): void {
  emit(action === "delete" ? "warn" : "info", `write.${entity}.${action}`, fields);
}

/**
 * A request that was refused.
 *
 * This is the line that would have made the two Critical vulnerabilities
 * visible while they were live: an unauthenticated caller reaching a server
 * action produces one of these every time.
 */
export function logDenied(surface: string, reason: string): void {
  emit("warn", "access.denied", { surface, reason });
}
