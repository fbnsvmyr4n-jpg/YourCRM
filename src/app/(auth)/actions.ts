"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/server/auth";
import {
  checkLoginRate,
  clearLoginRate,
  emailKey,
  ipKey,
  registerFailedLogin,
  signupKey,
} from "@/server/rate-limit-repo";
import { authenticate, createUser } from "@/server/users-repo";
import { email as validEmail, text } from "@/server/validate";

/** scrypt cost is paid per attempt — bound the input so it can't be abused. */
const MAX_PASSWORD = 200;

export type AuthState = { error?: string } | undefined;

/**
 * The caller's IP, for rate limiting.
 *
 * Behind Vercel the socket address is always the proxy, so the real client
 * comes from `x-forwarded-for` — first entry, since downstream proxies append.
 * A spoofed header can only ever *shift* an attacker between IP buckets; it
 * can't help them past the per-email limit, which is the one that actually
 * guards a known account.
 */
async function clientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return h.get("x-real-ip")?.trim() || "unknown";
}

function lockoutMessage(retryAfterSec: number) {
  const mins = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
}

/**
 * `remember` controls how long the sign-in lasts. Without it the cookie has no
 * maxAge, so the browser drops it when the window closes — which is what the
 * checkbox on the login form promises. The signed token still carries its own
 * expiry either way, so a kept cookie can't outlive the session it represents.
 */
async function startSession(userId: string, remember = true) {
  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(remember ? { maxAge: SESSION_MAX_AGE } : {}),
  });
}

export async function signInAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = text(formData.get("email"), 254);
  const password = String(formData.get("password") || "").slice(0, MAX_PASSWORD);

  if (!email || !password) return { error: "Enter your email and password." };

  const keys = [emailKey(email), ipKey(await clientIp())];

  // Checked *before* authenticating, so a locked-out caller never reaches the
  // scrypt verification — which is intentionally slow and would otherwise be
  // free CPU for an attacker to burn.
  const gate = await checkLoginRate(keys);
  if (!gate.allowed) return { error: lockoutMessage(gate.retryAfterSec) };

  const user = await authenticate(email, password);
  if (!user) {
    await registerFailedLogin(keys);
    // Deliberately identical whether the email exists or not — a different
    // message here would turn the login form into an account-enumeration oracle.
    return { error: "Incorrect email or password." };
  }

  await clearLoginRate(keys);
  await startSession(user.id, formData.get("remember") === "1");
  redirect("/");
}

export async function signUpAction(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const name = text(formData.get("name"), 80);
  const email = validEmail(formData.get("email"));
  const password = String(formData.get("password") || "").slice(0, MAX_PASSWORD);

  if (!name || !password) return { error: "All fields are required." };
  if (!email) return { error: "Enter a valid email address." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };

  // Signup is open, so it is also a way to fill the database with junk
  // accounts. Capped per IP, and counted on success too — the abuse here is
  // volume rather than guessing.
  const keys = [signupKey(await clientIp())];
  const gate = await checkLoginRate(keys);
  if (!gate.allowed) return { error: lockoutMessage(gate.retryAfterSec) };
  await registerFailedLogin(keys);

  // Email uniqueness is enforced atomically inside createUser — checking here
  // first would be a check-then-act race under concurrent signups.
  const { user, error } = await createUser({ name, email, password });
  if (error || !user) return { error: error ?? "Could not create the account." };

  await startSession(user.id);
  redirect("/");
}

export async function signOutAction() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
