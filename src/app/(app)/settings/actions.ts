"use server";

import { revalidateApp } from "@/server/revalidate";
import { isValidTimeZone, updateSettings } from "@/server/repos/settings";
import { changePassword, updateProfile } from "@/server/repos/users";
import { roleCan } from "@/server/permissions";
import { createSubAccount } from "@/server/sub-accounts";
import { withSystem } from "@/server/tenant";
import { requireTenant, SUB_ACCOUNT_COOKIE, withCurrentTenant } from "@/server/tenant-session";
import { count, email as validEmail, money, text } from "@/server/validate";
import { cookies } from "next/headers";

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


/**
 * Create a client workspace.
 *
 * Two separate refusals, deliberately not merged:
 *
 *  - **Who is asking.** Only an owner or admin creates workspaces. A member is
 *    somebody's employee working inside one client's data; letting them add
 *    another is both a permissions hole and, on a metered plan, a bill.
 *  - **What the plan allows.** Enforced inside `createSubAccount`, in the same
 *    transaction as the insert, because the limit is about a count of rows and
 *    checking it out here would leave a gap between the check and the write.
 *
 * The action does not enforce the cap itself. A gate that lives in the action
 * is a gate that a second caller — an API route, an import, a signup flow —
 * simply does not have.
 */
export async function createWorkspaceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireTenant();
  if (!roleCan(me.role, "manage_workspaces")) {
    return { error: "Only an owner or admin can add a workspace." };
  }

  const name = text(formData.get("name"), 80);
  if (!name) return { error: "Give the workspace a name." };
  const phoneNumber = text(formData.get("phoneNumber"), 40);

  const result = await withSystem((q) =>
    createSubAccount(q, me.agencyId, name, { phoneNumber })
  );
  if (!result.ok) return { error: result.error };

  revalidateApp();
  return { ok: `${name} is ready.` };
}

/**
 * Switch which client's workspace the session is looking at.
 *
 * The cookie is a *request*, not a decision: `resolveSubAccount` re-checks it
 * against the user's own agency on every request, so a hand-edited value
 * resolves to their default rather than to somebody else's data. It is still
 * validated here, so the person gets an answer instead of silently landing
 * back where they started.
 */
export async function switchWorkspaceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireTenant();

  const requested = text(formData.get("subAccountId"), 120);
  if (!requested) return { error: "Choose a workspace." };

  const owned = await withSystem((q) =>
    q.one<{ name: string }>(
      `SELECT name FROM sub_accounts
       WHERE id = $1 AND agency_id = $2 AND deleted_at IS NULL`,
      [requested, me.agencyId]
    )
  );
  if (!owned) return { error: "That workspace is not available on this account." };

  const store = await cookies();
  store.set(SUB_ACCOUNT_COOKIE, requested, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });

  // Everything on screen belongs to the previous workspace.
  revalidateApp();
  return { ok: `Now working in ${owned.name}.` };
}
