"use server";

import { revalidateApp } from "@/server/revalidate";
import { isValidTimeZone, updateSettings } from "@/server/repos/settings";
import { changePassword, updateProfile } from "@/server/repos/users";
import { withSystem } from "@/server/tenant";
import { requireTenant, withCurrentTenant } from "@/server/tenant-session";
import { count, email as validEmail, money, text } from "@/server/validate";

export type FormState = { ok?: string; error?: string } | undefined;

export async function updateTargetsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    const monthlyTarget = money(formData.get("monthlyTarget"));
    const weeklyCapacity = count(formData.get("weeklyCapacity"), 500);
    const timeZone = text(formData.get("timeZone"), 60);

    // These divide into percentages on the Meetings and Reports pages — a zero
    // or a non-number would produce Infinity or NaN on screen.
    if (monthlyTarget === null || monthlyTarget <= 0) {
      return { error: "Enter a monthly target greater than zero." };
    }
    if (weeklyCapacity === null || weeklyCapacity <= 0) {
      return { error: "Enter a weekly capacity greater than zero." };
    }
    // Rejected rather than quietly falling back to UTC: a wrong zone puts every
    // booking an hour or two out, and nothing on screen would say why.
    if (timeZone && !isValidTimeZone(timeZone)) {
      return { error: "That is not a recognised time zone." };
    }

    await updateSettings(q, {
      // The form takes whole currency units, which is what a person types.
      // Converted once, here.
      monthlyTargetCents: Math.round(monthlyTarget * 100),
      weeklyCapacity,
      ...(timeZone ? { timeZone } : {}),
    });

    // Several pages read these, so refresh the group rather than just Settings.
    revalidateApp();
    return { ok: "Targets updated." };
  });
}

export async function updateProfileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireTenant();

  const name = text(formData.get("name"), 80);
  const email = validEmail(formData.get("email"));
  if (!name) return { error: "Name is required." };
  if (!email) return { error: "Enter a valid email address." };

  const result = await withSystem((q) => updateProfile(q, me.userId, { name, email }));
  if (result.error) return { error: result.error };

  // Revalidate the layout so the sidebar/topbar pick up the new name,
  // without navigating the user away from Settings.
  revalidateApp();
  return { ok: "Profile updated." };
}

export async function changePasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireTenant();

  const current = String(formData.get("currentPassword") || "");
  const next = String(formData.get("newPassword") || "");
  const confirm = String(formData.get("confirmPassword") || "");

  if (!current || !next) return { error: "Fill in both password fields." };
  if (next !== confirm) return { error: "New passwords do not match." };

  const result = await withSystem((q) => changePassword(q, me.userId, current, next));
  if (result.error) return { error: result.error };

  return { ok: "Password changed." };
}
