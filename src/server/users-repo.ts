import { hashPassword, verifyPassword } from "./auth";
import { mutateTable, readTable } from "./store";

const TABLE = "users";

export type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  initials: string;
  passwordHash: string;
};

/** Public shape — never leaks the password hash to the client. */
export type SafeUser = Omit<User, "passwordHash">;

/**
 * A demo account is seeded so a fresh install is usable with no setup:
 * demo@yourcrm.com / demo1234
 *
 * That is a known password published in source — fine on localhost, not fine
 * on a public URL. Change it from Settings → Password immediately after the
 * first deploy. The README says so too.
 */
const seed: User[] = [
  {
    id: "user-lang-lee",
    name: "Lang Lee",
    email: "demo@yourcrm.com",
    role: "Admin",
    initials: "LL",
    passwordHash: hashPassword("demo1234"),
  },
];

function initialsFor(name: string) {
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? "";
  const b = parts[1]?.[0] ?? "";
  return (a + b || name.trim().slice(0, 2)).toUpperCase();
}

export function toSafeUser(u: User): SafeUser {
  const { passwordHash: _omit, ...safe } = u;
  void _omit;
  return safe;
}

export async function listUsers(): Promise<User[]> {
  return readTable<User>(TABLE, seed);
}

export async function findUserById(id: string): Promise<User | undefined> {
  const rows = await listUsers();
  return rows.find((u) => u.id === id);
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const rows = await listUsers();
  const needle = email.trim().toLowerCase();
  return rows.find((u) => u.email.toLowerCase() === needle);
}

/** Returns the user when the credentials are valid, otherwise null. */
export async function authenticate(email: string, password: string): Promise<User | null> {
  const user = await findUserByEmail(email);
  if (!user) return null;
  return verifyPassword(password, user.passwordHash) ? user : null;
}

/** Update the signed-in user's profile. */
export async function updateProfile(
  id: string,
  input: { name: string; email: string }
): Promise<{ user?: User; error?: string }> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || !email) return { error: "Name and email are required." };

  let result: { user?: User; error?: string } = {};
  // The uniqueness check and the write must happen under one lock, or two
  // concurrent updates could both claim the same email.
  await mutateTable<User>(TABLE, seed, (rows) => {
    const idx = rows.findIndex((u) => u.id === id);
    if (idx === -1) {
      result = { error: "Account not found." };
      return rows;
    }
    if (rows.some((u) => u.id !== id && u.email.toLowerCase() === email)) {
      result = { error: "That email is already in use." };
      return rows;
    }
    const updated: User = { ...rows[idx], name, email, initials: initialsFor(name) };
    const next = [...rows];
    next[idx] = updated;
    result = { user: updated };
    return next;
  });
  return result;
}

/** Change the password after verifying the current one. */
export async function changePassword(
  id: string,
  currentPassword: string,
  newPassword: string
): Promise<{ ok?: true; error?: string }> {
  if (newPassword.length < 8) return { error: "New password must be at least 8 characters." };

  let result: { ok?: true; error?: string } = {};
  await mutateTable<User>(TABLE, seed, (rows) => {
    const idx = rows.findIndex((u) => u.id === id);
    if (idx === -1) {
      result = { error: "Account not found." };
      return rows;
    }
    if (!verifyPassword(currentPassword, rows[idx].passwordHash)) {
      result = { error: "Your current password is incorrect." };
      return rows;
    }
    const next = [...rows];
    next[idx] = { ...next[idx], passwordHash: hashPassword(newPassword) };
    result = { ok: true };
    return next;
  });
  return result;
}

/**
 * Create an account. Email uniqueness is enforced *inside* the lock — checking
 * beforehand isn't enough, because two concurrent signups can both pass the
 * check and then both write, leaving duplicate accounts on one email (which
 * would make login ambiguous).
 */
export async function createUser(input: {
  name: string;
  email: string;
  password: string;
}): Promise<{ user?: User; error?: string }> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();

  let result: { user?: User; error?: string } = {};
  await mutateTable<User>(TABLE, seed, (rows) => {
    if (rows.some((u) => u.email.toLowerCase() === email)) {
      result = { error: "An account with that email already exists." };
      return rows;
    }
    const user: User = {
      id: `user-${Math.random().toString(36).slice(2, 10)}`,
      name,
      email,
      role: "Admin",
      initials: initialsFor(name),
      passwordHash: hashPassword(input.password),
    };
    result = { user };
    return [...rows, user];
  });
  return result;
}
