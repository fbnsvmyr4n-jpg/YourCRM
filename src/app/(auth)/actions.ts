"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  createSessionToken,
  readSessionToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
} from "@/server/auth";
import {
  checkLoginRate,
  clearLoginRate,
  emailKey,
  ipKey,
  registerFailedLogin,
  signupKey,
} from "@/server/repos/auth";
import { authenticate } from "@/server/repos/users";
import { signUp } from "@/server/signup";
import { withSystem } from "@/server/tenant";
import { email as validEmail, text } from "@/server/validate";
import { logAuth } from "@/server/log";

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
  const gate = await withSystem((q) => checkLoginRate(q, keys));
  if (!gate.allowed) {
    logAuth("ratelimited", { email, reason: "too many failed attempts" });
    return { error: lockoutMessage(gate.retryAfterSec) };
  }

  const user = await withSystem((q) => authenticate(q, email, password));
  if (!user) {
    await withSystem((q) => registerFailedLogin(q, keys));
    logAuth("signin.failed", { email });
    // Deliberately identical whether the email exists or not — a different
    // message here would turn the login form into an account-enumeration oracle.
    return { error: "Incorrect email or password." };
  }

  await withSystem((q) => clearLoginRate(q, keys));
  logAuth("signin.ok", { userId: user.id });
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
  const gate = await withSystem((q) => checkLoginRate(q, keys));
  if (!gate.allowed) return { error: lockoutMessage(gate.retryAfterSec) };
  await withSystem((q) => registerFailedLogin(q, keys));

  // Email uniqueness is enforced atomically inside createUser — checking here
  // first would be a check-then-act race under concurrent signups.
  // Signing up creates a tenant — an agency, its primary workspace, and an
  // owner inside it — not just a row in `users`. All three in one transaction,
  // because a half-created tenant is somebody who can sign in and has nowhere
  // to work.
  const { user, error } = await signUp({ name, email, password });
  if (error || !user) {
    logAuth("signup.failed", { email, reason: error ?? "unknown" });
    return { error: error ?? "Could not create the account." };
  }

  logAuth("signup.ok", { userId: user.id });
  await startSession(user.id);
  redirect("/");
}

export async function signOutAction() {
  const store = await cookies();
  const userId = readSessionToken(store.get(SESSION_COOKIE)?.value) ?? undefined;
  logAuth("signout", { userId });
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
