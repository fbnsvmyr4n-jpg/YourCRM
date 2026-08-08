"use server";

import { revalidateApp } from "@/server/revalidate";
import { getCurrentUser } from "@/server/session";
import { updateSettings } from "@/server/settings-repo";
import { changePassword, updateProfile } from "@/server/users-repo";
import { count, email as validEmail, money, text } from "@/server/validate";

export type FormState = { ok?: string; error?: string } | undefined;

export async function updateTargetsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await getCurrentUser();
  if (!me) return { error: "You are not signed in." };

  const monthlyTarget = money(formData.get("monthlyTarget"));
  const weeklyCapacity = count(formData.get("weeklyCapacity"), 500);

  // These divide into percentages on the Leads and Meetings pages — a zero or
  // a non-number would produce Infinity or NaN on screen.
  if (monthlyTarget === null || monthlyTarget <= 0) {
    return { error: "Enter a monthly target greater than zero." };
  }
  if (weeklyCapacity === null || weeklyCapacity <= 0) {
    return { error: "Enter a weekly capacity greater than zero." };
  }

  await updateSettings({ monthlyTarget, weeklyCapacity });
  // Both pages read these, so refresh the whole group rather than just Settings.
  revalidateApp();
  return { ok: "Targets updated." };
}

export async function updateProfileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await getCurrentUser();
  if (!me) return { error: "You are not signed in." };

  const name = text(formData.get("name"), 80);
  const email = validEmail(formData.get("email"));
  if (!name) return { error: "Name is required." };
  if (!email) return { error: "Enter a valid email address." };

  const result = await updateProfile(me.id, { name, email });
  if (result.error) return { error: result.error };

  // Revalidate the layout so the sidebar/topbar pick up the new name,
  // without navigating the user away from Settings.
  revalidateApp();
  return { ok: "Profile updated." };
}

export async function changePasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await getCurrentUser();
  if (!me) return { error: "You are not signed in." };

  const current = String(formData.get("currentPassword") || "");
  const next = String(formData.get("newPassword") || "");
  const confirm = String(formData.get("confirmPassword") || "");

  if (!current || !next) return { error: "Fill in both password fields." };
  if (next !== confirm) return { error: "New passwords do not match." };

  const result = await changePassword(me.id, current, next);
  if (result.error) return { error: result.error };

  return { ok: "Password changed." };
}
