"use server";

import { headers } from "next/headers";
import { emailConfigured, resetEmail, sendEmail } from "@/server/email";
import { consumeResetToken, createResetToken } from "@/server/repos/auth";
import {
  checkLoginRate,
  ipKey,
  registerFailedLogin,
} from "@/server/repos/auth";
import { findUserByEmail, setPassword } from "@/server/repos/users";
import { withSystem } from "@/server/tenant";
import { email as validEmail, text } from "@/server/validate";

export type ResetState = { ok?: string; error?: string; devLink?: string } | undefined;

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Request a reset link.
 *
 * Always reports the same thing whether or not the address exists. Saying "no
 * such account" would turn this form into a way to discover which addresses
 * are registered, which is the same reason the sign-in error is deliberately
 * vague.
 */
export async function requestResetAction(_prev: ResetState, formData: FormData): Promise<ResetState> {
  const address = validEmail(formData.get("email"));
  if (!address) return { error: "Enter a valid email address." };

  // Sending mail costs money and hits a third party, so the same per-IP limit
  // that guards sign-in guards this too.
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
  const keys = [ipKey(ip)];
  const gate = await withSystem((q) => checkLoginRate(q, keys));
  if (!gate.allowed) {
    const mins = Math.max(1, Math.ceil(gate.retryAfterSec / 60));
    return { error: `Too many requests. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` };
  }
  await withSystem((q) => registerFailedLogin(q, keys));

  const generic = {
    ok: "If that address has an account, a reset link is on its way. Check your inbox.",
  } satisfies ResetState;

  const user = await withSystem((q) => findUserByEmail(q, address));
  if (!user) return generic;

  const token = await withSystem((q) => createResetToken(q, user.id, user.email));
  const link = `${await origin()}/reset-password?token=${encodeURIComponent(token)}`;
  const mail = resetEmail(link);
  const result = await sendEmail({ to: user.email, ...mail });

  // Without a provider the token is still valid, so in development the link is
  // surfaced directly rather than silently going nowhere.
  if (!result.sent && !emailConfigured() && process.env.NODE_ENV !== "production") {
    return { ...generic, devLink: link };
  }
  if (!result.sent && process.env.NODE_ENV === "production") {
    return { error: "Couldn't send the email just now. Please try again shortly." };
  }
  return generic;
}

/** Redeem a token and set the new password. */
export async function resetPasswordAction(_prev: ResetState, formData: FormData): Promise<ResetState> {
  const token = text(formData.get("token"), 200);
  const password = String(formData.get("password") || "").slice(0, 200);
  const confirm = String(formData.get("confirm") || "").slice(0, 200);

  if (!token) return { error: "This reset link is invalid." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };
  if (password !== confirm) return { error: "Passwords do not match." };

  // Consumed before the write, so a link cannot be redeemed twice even if two
  // requests arrive together.
  const claim = await withSystem((q) => consumeResetToken(q, token));
  if (!claim) return { error: "This reset link has expired or already been used." };

  const result = await withSystem((q) => setPassword(q, claim.userId, password));
  if (result.error) return { error: result.error };

  return { ok: "Password updated. You can sign in with your new password." };
}
