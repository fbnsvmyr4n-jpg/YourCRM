"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/server/auth";
import { authenticate, createUser } from "@/server/users-repo";
import { email as validEmail, text } from "@/server/validate";

/** scrypt cost is paid per attempt — bound the input so it can't be abused. */
const MAX_PASSWORD = 200;

export type AuthState = { error?: string } | undefined;

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

  const user = await authenticate(email, password);
  if (!user) return { error: "Incorrect email or password." };

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
