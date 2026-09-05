"use server";

import { revalidateApp } from "@/server/revalidate";
import { isValidTimeZone, updateSettings } from "@/server/repos/settings";
import { changePassword, updateProfile } from "@/server/repos/users";
import { agencyBilling, applyCreditToStripe, billingPortal, startCheckout } from "@/server/billing/checkout";
import { PLAN_INFO } from "@/server/billing/plans";
import { applicableCredit, creditSummary } from "@/server/referral-rewards";
import { isPlan } from "@/server/billing/plans";
import { roleCan } from "@/server/permissions";
import { createSubAccount } from "@/server/sub-accounts";
import { withSystem } from "@/server/tenant";
import { requireTenant, SUB_ACCOUNT_COOKIE, withCurrentTenant } from "@/server/tenant-session";
import { isTrashKind, nounFor, restoreFromTrash } from "@/server/trash";
import { count, email as validEmail, money, multiline, text } from "@/server/validate";
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

/**
 * `crmData: false` because a revenue target and a weekly capacity are numbers
 * the business chooses about itself, not records about a customer. An owner or
 * a finance user setting the month's target is not reading anybody's contact
 * details.
 *
 * `restoreDeletedAction` below is deliberately NOT opted out: what it puts back
 * is contacts, deals and meetings.
 */
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
  }, { crmData: false });
}

export async function updateProfileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireTenant();

  const name = text(formData.get("name"), 80);
  const email = validEmail(formData.get("email"));
  if (!name) return { error: "Name is required." };
  if (!email) return { error: "Enter a valid email address." };

  /* Your own directory entry, edited here rather than under Team — that screen
     deliberately refuses `me`, so there is exactly one form that can change
     your own details and one set of validation behind it.

     Sent every time, empty meaning cleared. Skipping blank fields would make
     the form able to fill a phone number in and never take it out again. */
  const details = {
    department: text(formData.get("department"), 60),
    jobTitle: text(formData.get("jobTitle"), 80),
    phone: text(formData.get("phone"), 40),
    scope: multiline(formData.get("scope"), 400),
  };

  const result = await withSystem((q) => updateProfile(q, me.userId, { name, email, ...details }));
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
    return { error: "Only an owner or the finance team can change the subscription." };
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
    return { error: "Only an owner or the finance team can manage billing." };
  }

  const result = await withSystem((q) => billingPortal(q, me.agencyId));
  if (!result.ok) return { error: result.error };

  return { redirect: result.url };
}


/**
 * Spend referral credit against the next invoice.
 *
 * The cap is applied server-side, not trusted from the form: the amount is
 * derived from the balance and the invoice, so a hand-edited number cannot
 * spend credit that was never earned.
 */
export async function applyReferralCreditAction(
  _prev: FormState,
  _formData: FormData
): Promise<FormState> {
  const me = await requireTenant();
  if (!roleCan(me.role, "manage_billing")) {
    return { error: "Only an owner or the finance team can use referral credit." };
  }

  return withSystem(async (q) => {
    const summary = await creditSummary(q, me.agencyId);
    const account = await agencyBilling(q, me.agencyId);
    const plan = account?.plan ?? "starter";
    const invoiceCents = PLAN_INFO[plan as keyof typeof PLAN_INFO]?.priceCents ?? 0;

    const amount = applicableCredit(summary.balanceCents, invoiceCents);
    if (amount <= 0) {
      return { error: "There is no credit to apply to your next invoice yet." };
    }

    const result = await applyCreditToStripe(q, me.agencyId, amount);
    if (!result.ok) return { error: result.error };

    revalidateApp();
    return { ok: `$${(amount / 100).toFixed(2)} applied to your next invoice.` };
  });
}

/**
 * Put one deleted record back.
 *
 * Not gated on a capability. Anyone who can delete a record can restore one,
 * and restoring is strictly the less destructive of the two — a permission that
 * let someone delete but not undo would be a trap rather than a safeguard.
 *
 * The kind is validated against the list before it reaches the dispatch table,
 * so a hand-edited value selects nothing rather than a table of its own
 * choosing. Row-level security handles the rest: an id from another workspace
 * matches no row, and the answer is the same "no longer there" a stale id gets.
 *
 * That validation happens INSIDE the tenant call, not before it. Written the
 * other way round the authorisation suite went red, and it was right to: an
 * unauthenticated caller could tell a recognised kind from an unrecognised one
 * by the wording of the refusal. The rule that the guard is the first statement
 * exists precisely so it never has to be argued case by case.
 */
export async function restoreDeletedAction(kind: string, id: string): Promise<FormState> {
  return withCurrentTenant(async (q) => {
    if (!isTrashKind(kind)) return { error: "That is not something this can restore." };
    const recordId = text(id, 64);
    if (!recordId) return { error: "That record could not be identified." };

    const restored = await restoreFromTrash(q, kind, recordId);
    if (!restored) {
      return { error: "That record is no longer in the deleted list." };
    }

    // It reappears on its own page, not this one, so refresh the group.
    revalidateApp();
    return { ok: `${nounFor(kind)} restored.` };
  });
}
