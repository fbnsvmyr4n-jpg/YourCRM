import { cookies } from "next/headers";
import { readSessionToken, SESSION_COOKIE } from "./auth";
import { logDenied } from "./log";
import { findUserById, toSafeUser, type SafeUser } from "./users-repo";

/** The signed-in user for the current request, or null. */
export async function getCurrentUser(): Promise<SafeUser | null> {
  const store = await cookies();
  const userId = readSessionToken(store.get(SESSION_COOKIE)?.value);
  if (!userId) return null;
  const user = await findUserById(userId);
  return user ? toSafeUser(user) : null;
}

/**
 * The signed-in user, or throw. **Every mutating server action calls this first.**
 *
 * The route guard in `(app)/layout.tsx` is a server *component*: it decides
 * whether a page renders, and a server action never passes through it. Actions
 * are independently addressable POST endpoints whose ids are recoverable from
 * the built client bundle, so an unguarded action is reachable by anyone who
 * can reach the origin — signed in or not.
 *
 * That was not theoretical. Before this existed, a request carrying nothing but
 * an action id deleted a real row from the production database:
 *
 *     POST /deals
 *     Next-Action: 40a63db6800536266d608c2fdada147a368b24bf53
 *     ["deal-movers-co-9n6q","won"]        ->  HTTP 200, record destroyed
 *
 * Throwing rather than returning null is deliberate: a caller that forgets to
 * check the result still fails closed.
 */
export async function requireUser(): Promise<SafeUser> {
  const user = await getCurrentUser();
  if (!user) {
    // The line that would have made both Critical vulnerabilities visible while
    // they were live. An unauthenticated caller reaching an action now leaves a
    // trace; previously it left none, on a public URL, for three weeks.
    logDenied("server-action", "no valid session");
    throw new Error("Not authenticated.");
  }
  return user;
}
