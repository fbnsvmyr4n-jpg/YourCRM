import { hashPassword, verifyPassword } from "../auth";
import type { Role, SystemQuery } from "../tenant";

/**
 * Users.
 *
 * Takes a `SystemQuery` rather than a tenant one, and the reason is structural:
 * sign-in happens before there is a tenant to scope to, so `withTenant` cannot
 * serve `findByEmail`. Everything else here is agency-level anyway — a user
 * belongs to an agency, and may or may not be pinned to one sub-account — so
 * the filtering is by `agency_id`, done explicitly in every statement.
 *
 * The password hash never leaves this module. `SafeUser` is what callers get,
 * and it has no field to leak; there is no "remember to strip it" step, because
 * the shape that carries it is not exported.
 */

/**
 * The directory fields.
 *
 * Separate from the permission fields above them, and worth keeping separate:
 * `role` decides what somebody may DO and is enforced; these describe who they
 * are, and nothing reads them for a decision. Every one is optional — an
 * account that fills none of them in works exactly as it did before they
 * existed.
 */
export type StaffDetails = {
  /** Groups the directory. Null is "not filed yet", shown as its own group. */
  department: string | null;
  jobTitle: string | null;
  /** Free text on purpose: an internal directory, where "x204" is an answer. */
  phone: string | null;
  /** What they are responsible for, in their own words. */
  scope: string | null;
};

export type SafeUser = {
  id: string;
  agencyId: string;
  /** Null for agency-wide staff, who are not pinned to a single client. */
  subAccountId: string | null;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
} & StaffDetails;

type Row = {
  id: string;
  agency_id: string;
  sub_account_id: string | null;
  name: string;
  email: string;
  role: Role;
  department: string | null;
  job_title: string | null;
  phone: string | null;
  scope: string | null;
  created_at: Date;
};

type RowWithHash = Row & { password_hash: string };

const COLUMNS = `u.id, u.agency_id, u.sub_account_id, u.name, u.email, u.role,
                 u.department, u.job_title, u.phone, u.scope, u.created_at`;

/** Empty strings from a form mean "cleared", not "the empty string". */
function orNull(value: string | null | undefined): string | null {
  const v = value?.trim() ?? "";
  return v === "" ? null : v;
}

function toSafeUser(r: Row): SafeUser {
  return {
    id: r.id,
    agencyId: r.agency_id,
    subAccountId: r.sub_account_id,
    name: r.name,
    email: r.email,
    role: r.role,
    department: r.department,
    jobTitle: r.job_title,
    phone: r.phone,
    scope: r.scope,
    createdAt: r.created_at.toISOString(),
  };
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserById(q: SystemQuery, id: string): Promise<SafeUser | null> {
  const row = await q.one<Row>(
    `SELECT ${COLUMNS} FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [id]
  );
  return row ? toSafeUser(row) : null;
}

export async function findUserByEmail(q: SystemQuery, email: string): Promise<SafeUser | null> {
  // Matched case-insensitively against the same expression the unique index
  // uses, so "Bradley@..." and "bradley@..." cannot become two accounts.
  const row = await q.one<Row>(
    `SELECT ${COLUMNS} FROM users u WHERE lower(u.email) = $1 AND u.deleted_at IS NULL`,
    [normaliseEmail(email)]
  );
  return row ? toSafeUser(row) : null;
}

export async function listUsers(q: SystemQuery, agencyId: string): Promise<SafeUser[]> {
  const rows = await q.rows<Row>(
    `SELECT ${COLUMNS} FROM users u
     WHERE u.agency_id = $1 AND u.deleted_at IS NULL
     ORDER BY u.created_at ASC, u.id`,
    [agencyId]
  );
  return rows.map(toSafeUser);
}

/**
 * Verify a password.
 *
 * Returns null for both "no such user" and "wrong password", deliberately: a
 * caller that could tell them apart would leak which addresses have accounts,
 * and that difference tends to reach the user as two different error messages.
 *
 * The hash is compared here and discarded; it is never returned.
 */
export async function authenticate(
  q: SystemQuery,
  email: string,
  password: string
): Promise<SafeUser | null> {
  const row = await q.one<RowWithHash>(
    `SELECT ${COLUMNS}, u.password_hash FROM users u
     WHERE lower(u.email) = $1 AND u.deleted_at IS NULL`,
    [normaliseEmail(email)]
  );
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return toSafeUser(row);
}

export async function createUser(
  q: SystemQuery,
  input: {
    agencyId: string;
    email: string;
    password: string;
    name: string;
    role?: Role;
    subAccountId?: string | null;
  } & Partial<StaffDetails>
): Promise<{ user?: SafeUser; error?: string }> {
  const email = normaliseEmail(input.email);
  if (!email.includes("@")) return { error: "That does not look like an email address." };
  if (input.password.length < 8) return { error: "Password must be at least 8 characters." };
  if (!input.name.trim()) return { error: "A name is required." };

  // The unique index is the actual guard; this catch turns its error into
  // something a user can read. Checking first and inserting after would leave a
  // race between the two statements — two simultaneous signups would both pass
  // the check and one would crash.
  try {
    const row = await q.one<Row>(
      `INSERT INTO users (id, agency_id, sub_account_id, name, email, password_hash, role,
                          department, job_title, phone, scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, agency_id, sub_account_id, name, email, role,
                 department, job_title, phone, scope, created_at`,
      [
        `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        input.agencyId,
        input.subAccountId ?? null,
        input.name.trim(),
        email,
        hashPassword(input.password),
        input.role ?? "member",
        orNull(input.department),
        orNull(input.jobTitle),
        orNull(input.phone),
        orNull(input.scope),
      ]
    );
    return row ? { user: toSafeUser(row) } : { error: "The account was not created." };
  } catch (err) {
    if (String(err).includes("users_email_unique")) {
      return { error: "An account with that email already exists." };
    }
    throw err;
  }
}

/**
 * Change somebody's own details.
 *
 * `COALESCE($n, column)` means an argument of NULL leaves the column alone, so
 * a caller sends only what it is changing. That is what makes the profile form
 * and the directory form able to share one statement without either wiping the
 * other's fields.
 *
 * It also means a directory field cannot be CLEARED by passing null, which is
 * why the four of them take an explicit `undefined` to mean "not editing" and
 * an empty string to mean "clear it" — the distinction the `clear` flags below
 * carry into SQL. Getting this wrong the obvious way produces a form that can
 * fill a phone number in and never take it out again.
 */
export async function updateProfile(
  q: SystemQuery,
  id: string,
  patch: { name?: string; email?: string } & Partial<StaffDetails>
): Promise<{ user?: SafeUser; error?: string }> {
  const email = patch.email !== undefined ? normaliseEmail(patch.email) : null;
  if (email !== null && !email.includes("@")) {
    return { error: "That does not look like an email address." };
  }
  if (patch.name !== undefined && !patch.name.trim()) {
    return { error: "A name is required." };
  }

  /* Per field: is it being edited at all, and if so what to. `editing` is the
     flag SQL branches on; the value may legitimately be NULL. */
  const editing = {
    department: patch.department !== undefined,
    jobTitle: patch.jobTitle !== undefined,
    phone: patch.phone !== undefined,
    scope: patch.scope !== undefined,
  };

  try {
    const row = await q.one<Row>(
      `UPDATE users SET
         name       = COALESCE($2, name),
         email      = COALESCE($3, email),
         department = CASE WHEN $4  THEN $5  ELSE department END,
         job_title  = CASE WHEN $6  THEN $7  ELSE job_title  END,
         phone      = CASE WHEN $8  THEN $9  ELSE phone      END,
         scope      = CASE WHEN $10 THEN $11 ELSE scope      END
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, agency_id, sub_account_id, name, email, role,
                 department, job_title, phone, scope, created_at`,
      [
        id,
        patch.name?.trim() ?? null,
        email,
        editing.department,
        orNull(patch.department),
        editing.jobTitle,
        orNull(patch.jobTitle),
        editing.phone,
        orNull(patch.phone),
        editing.scope,
        orNull(patch.scope),
      ]
    );
    return row ? { user: toSafeUser(row) } : { error: "That account no longer exists." };
  } catch (err) {
    if (String(err).includes("users_email_unique")) {
      return { error: "An account with that email already exists." };
    }
    throw err;
  }
}

/**
 * Change a password, checking the current one first.
 *
 * Requiring the old password is what stops a borrowed session from locking the
 * real owner out of their account permanently.
 */
export async function changePassword(
  q: SystemQuery,
  id: string,
  currentPassword: string,
  newPassword: string
): Promise<{ ok?: true; error?: string }> {
  if (newPassword.length < 8) return { error: "Password must be at least 8 characters." };

  const row = await q.one<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  if (!row) return { error: "That account no longer exists." };
  if (!verifyPassword(currentPassword, row.password_hash)) {
    return { error: "That is not your current password." };
  }

  await q.rows(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, hashPassword(newPassword)]);
  return { ok: true };
}

/**
 * Set a password without the old one — only for a consumed reset token.
 *
 * Separate from `changePassword` so the "no current password needed" path is
 * one named function that can be found and audited, rather than an optional
 * argument somewhere that is easy to pass by accident.
 */
export async function setPassword(
  q: SystemQuery,
  id: string,
  newPassword: string
): Promise<{ ok?: true; error?: string }> {
  if (newPassword.length < 8) return { error: "Password must be at least 8 characters." };
  const row = await q.one<{ id: string }>(
    `UPDATE users SET password_hash = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id, hashPassword(newPassword)]
  );
  return row ? { ok: true } : { error: "That account no longer exists." };
}

/**
 * Change a colleague's role.
 *
 * Two things are enforced in the statement rather than around it:
 *
 *  - **`agency_id = $2`.** Ids are globally unique, so an id from another
 *    agency is a perfectly valid-looking string. Scoping the write means a
 *    hand-edited form matches no row rather than promoting a stranger.
 *  - **The last owner cannot be demoted.** Checking that with a separate
 *    SELECT leaves a gap: two admins demoting the two remaining owners at the
 *    same moment would both read "there is another owner" and both succeed,
 *    leaving an agency nobody can bill for. The EXISTS clause is part of the
 *    same UPDATE, so one of the two writes matches no row.
 *
 * A null return is therefore "not yours, gone, or the last owner" — the caller
 * asks a second question only to word the message, never to decide.
 */
export async function setUserRole(
  q: SystemQuery,
  agencyId: string,
  id: string,
  role: Role
): Promise<SafeUser | null> {
  const row = await q.one<Row>(
    `UPDATE users u SET role = $3
     WHERE u.id = $1 AND u.agency_id = $2 AND u.deleted_at IS NULL
       AND ($3 = 'owner' OR u.role <> 'owner' OR EXISTS (
             SELECT 1 FROM users o
             WHERE o.agency_id = $2 AND o.role = 'owner'
               AND o.deleted_at IS NULL AND o.id <> $1))
     RETURNING u.id, u.agency_id, u.sub_account_id, u.name, u.email, u.role,
               u.department, u.job_title, u.phone, u.scope, u.created_at`,
    [id, agencyId, role]
  );
  return row ? toSafeUser(row) : null;
}

/**
 * Remove a colleague from the agency.
 *
 * Same two guarantees as `setUserRole`, for the same reasons: scoped to the
 * agency, and the last owner survives. Losing every owner would leave nobody
 * able to change the subscription, and no screen in the product could grant it
 * back.
 */
export async function removeTeamMember(
  q: SystemQuery,
  agencyId: string,
  id: string
): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE users u SET deleted_at = now()
     WHERE u.id = $1 AND u.agency_id = $2 AND u.deleted_at IS NULL
       AND (u.role <> 'owner' OR EXISTS (
             SELECT 1 FROM users o
             WHERE o.agency_id = $2 AND o.role = 'owner'
               AND o.deleted_at IS NULL AND o.id <> $1))
     RETURNING u.id`,
    [id, agencyId]
  );
  return row !== null;
}

/** Soft delete, which also frees the email address for reuse. */
export async function deleteUser(q: SystemQuery, id: string): Promise<boolean> {
  const row = await q.one<{ id: string }>(
    `UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id]
  );
  return row !== null;
}
