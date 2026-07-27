import { cookies } from "next/headers";
import { readSessionToken, SESSION_COOKIE } from "./auth";
import { findUserById, toSafeUser, type SafeUser } from "./users-repo";

/** The signed-in user for the current request, or null. */
export async function getCurrentUser(): Promise<SafeUser | null> {
  const store = await cookies();
  const userId = readSessionToken(store.get(SESSION_COOKIE)?.value);
  if (!userId) return null;
  const user = await findUserById(userId);
  return user ? toSafeUser(user) : null;
}
