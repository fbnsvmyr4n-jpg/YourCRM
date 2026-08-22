import { entitlementsFor, explain, hasRoomFor } from "./entitlements";
import { logDenied, logWrite } from "./log";
import type { SystemQuery } from "./tenant";

/**
 * Creating a client workspace, and the limit that applies to it.
 *
 * This is where a tier stops being a marketing line and becomes a number the
 * software enforces. Starter sells three sub-accounts; the fourth has to be
 * refused, and refused in a way that tells the person what to do about it.
 *
 * The count is taken inside the same transaction as the insert. Reading the
 * count, deciding, and then writing in three separate steps is how a Starter
 * account ends up with five workspaces: two requests both see three, both
 * conclude there is room, and both write.
 */

export type CreateResult =
  | { ok: true; id: string }
  | { ok: false; error: string; upgrade?: boolean };

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 24) || "client"
  );
}

export async function createSubAccount(
  q: SystemQuery,
  agencyId: string,
  name: string,
  opts: { phoneNumber?: string | null } = {}
): Promise<CreateResult> {
  const label = name.trim();
  if (!label) return { ok: false, error: "Give the workspace a name." };

  const e = await entitlementsFor(q, agencyId);

  // Not entitled at all — a lapsed trial or a cancelled plan. Says which,
  // rather than "not allowed".
  const allowed = explain(e, "sub_accounts");
  if (!allowed.allowed) {
    logDenied("sub-account-create", `agency ${agencyId}: ${e.reason ?? "not entitled"}`);
    return { ok: false, error: allowed.reason, upgrade: true };
  }

  /**
   * Counted with a lock on the agency row, so two simultaneous creations
   * cannot both see room for the last one.
   *
   * `pg_advisory_xact_lock` rather than `SELECT … FOR UPDATE` on the agency:
   * the thing being protected is a COUNT of other rows, not the agency row
   * itself, so locking the row somebody happens to read is incidental. The
   * advisory lock names the invariant directly.
   */
  await q.rows(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sub_accounts:${agencyId}`]);

  const existing = await q.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM sub_accounts WHERE agency_id = $1 AND deleted_at IS NULL`,
    [agencyId]
  );
  const count = Number(existing?.n ?? 0);

  if (!hasRoomFor(e, "sub_accounts", count)) {
    const cap = e.grants.get("sub_accounts");
    logDenied("sub-account-create", `agency ${agencyId}: at the limit of ${cap}`);
    return {
      ok: false,
      // Names the number and the way out. "Limit reached" alone is a dead end.
      error: `Your plan includes ${cap} client workspace${cap === 1 ? "" : "s"}, and you have ${count}. Upgrade for more.`,
      upgrade: true,
    };
  }

  const id = `sa-${slug(label)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  try {
    await q.rows(
      `INSERT INTO sub_accounts (id, agency_id, name, is_primary, phone_number)
       VALUES ($1, $2, $3, FALSE, $4)`,
      [id, agencyId, label, opts.phoneNumber?.trim() || null]
    );
  } catch (err) {
    // The number is unique across the platform because an inbound call has to
    // resolve to exactly one workspace.
    if (String(err).includes("phone_number")) {
      return { ok: false, error: "That phone number is already in use by another workspace." };
    }
    throw err;
  }

  logWrite("create", "sub_account", { id, detail: `agency ${agencyId}` });
  return { ok: true, id };
}
