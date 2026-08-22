"use server";

import { revalidateApp } from "@/server/revalidate";
import { isValidTimeZone, updateSettings } from "@/server/repos/settings";
import { changePassword, updateProfile } from "@/server/repos/users";
import { billingPortal, startCheckout } from "@/server/billing/checkout";
import { isPlan } from "@/server/billing/plans";
import { roleCan } from "@/server/permissions";
import { createSubAccount } from "@/server/sub-accounts";
import { withSystem } from "@/server/tenant";
import { requireTenant, SUB_ACCOUNT_COOKIE, withCurrentTenant } from "@/server/tenant-session";
import { count, email as validEmail, money, text } from "@/server/validate";
import { cookies } from "next/headers";

/**
 * `redirect` is a URL the browser should be sent to — Stripe's checkout or
 * billing portal.
 *
 * Not an actual `redirect()` call: that throws a control-flow signal, and
 * `useActionState` cannot render an error next to a form whose action never
 * returns. A refusal would leave the customer looking at a page where nothing
 * happened and nothing explained why. Handed back so the component navigates
 * only when there is somewhere to go.
 */
export type FormState = { ok?: string; error?: string; redirect?: string } | undefined;

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


/**
 * Start checkout for a plan.
 *
 * Billing is the owner's. An admin runs the agency day to day and is trusted
 * with the work, not with changing what the business pays every month.
 *
 * Returns the Stripe URL rather than redirecting from the action. A redirect
 * here throws a control-flow signal that `useActionState` cannot show an error
 * beside, so a refusal would leave the customer on a page where nothing
 * happened and nothing said why.
 */
export async function startCheckoutAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireTenant();
  if (!roleCan(me.role, "manage_billing")) {
    return { error: "Only the account owner can change the subscription." };
  }

  const plan = text(formData.get("plan"), 20);
  if (!plan || !isPlan(plan)) return { error: "Choose a plan." };

  const user = await withSystem((q) =>
    q.one<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [me.userId])
  );

  const result = await withSystem((q) =>
    startCheckout(q, me.agencyId, plan, user?.email ?? "")
  );
  if (!result.ok) return { error: result.error };

  return { redirect: result.url };
}

/**
 * Open Stripe's billing portal.
 *
 * Cards, invoices, cancellation and plan changes all live there. Rebuilding any
 * of it here would mean handling card details, which is a compliance burden
 * this product has no reason to take on.
 */
export async function billingPortalAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const me = await requireTenant();
  if (!roleCan(me.role, "manage_billing")) {
    return { error: "Only the account owner can manage billing." };
  }

  const result = await withSystem((q) => billingPortal(q, me.agencyId));
  if (!result.ok) return { error: result.error };

  return { redirect: result.url };
}
