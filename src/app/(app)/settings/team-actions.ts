"use server";

import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { emailConfigured, inviteEmail, sendEmail } from "@/server/email";
import { outranks, roleCan } from "@/server/permissions";
import { createResetToken } from "@/server/repos/auth";
import { createUser, removeTeamMember, setUserRole, updateProfile } from "@/server/repos/users";
import { requireActivePlan } from "@/server/plan-gate";
import { revalidateApp } from "@/server/revalidate";
import { ROLES, withSystem } from "@/server/tenant";
import { requireTenant } from "@/server/tenant-session";
import { email as validEmail, id as validId, multiline, pick, text } from "@/server/validate";
import type { FormState } from "./actions";

/**
 * Colleagues on the account.
 *
 * The capability already existed — `manage_users` was in the matrix, granted to
 * owner and admin — with nothing in the product that used it. An agency owner
 * could not add the person who actually answers the phone, which made every
 * other permission decision theoretical.
 *
 * Three rules run through all of this and are worth stating once:
 *
 *  - **Every write is scoped to the caller's own agency**, inside the SQL. Ids
 *    are globally unique, so an id belonging to another customer is a
 *    valid-looking string; scoping the statement means a hand-edited form
 *    matches no row rather than editing a stranger.
 *  - **The last owner is untouchable.** Enforced in the UPDATE itself, not by a
 *    SELECT beforehand, so two simultaneous demotions cannot both pass.
 *  - **Nobody edits themselves here.** Your own name and password live in
 *    Account. Letting this screen demote or delete the person using it is a way
 *    to lock an owner out of their own billing with one click.
 */

/** The invite link's own origin, so a staging deploy does not mail production URLs. */
async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Invite a colleague.
 *
 * The account is created with a random password nobody ever sees — not a
 * default, not a shared one — and the invitation carries a single-use reset
 * link instead. A password in an email is a live credential sitting in a
 * mailbox for as long as the mailbox exists.
 *
 * An owner can invite an owner; an admin cannot. Otherwise an admin could
 * promote themselves in two moves — invite an owner account at an address they
 * control, then sign in as it — and the billing gate would be decoration.
 */
export async function inviteMemberAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireTenant();
  if (!roleCan(me.role, "manage_users")) {
    return { error: "Only an owner or admin can add people to this account." };
  }
  /* Adding a colleague is product use, not account management: a lapsed
     account should not be able to grow. Changing a role and removing somebody
     deliberately are NOT gated — see their own notes. */
  await requireActivePlan(me.agencyId, "inviteMemberAction");

  const name = text(formData.get("name"), 80);
  const address = validEmail(formData.get("email"));
  const role = pick(formData.get("role"), ROLES);
  /* Where they sit and what they are called, taken at the point of invitation
     so a new colleague is in the directory the moment they appear in it —
     rather than as a blank row somebody has to remember to come back and fill
     in. Both optional: not knowing somebody's title is no reason to be unable
     to give them a login. */
  const department = text(formData.get("department"), 60);
  const jobTitle = text(formData.get("jobTitle"), 80);

  if (!name) return { error: "Give them a name." };
  if (!address) return { error: "Enter a valid email address." };
  if (!role) return { error: "Choose a role." };
  if (!outranks(me.role, role)) {
    return { error: "Only an owner can add another owner." };
  }

  const created = await withSystem((q) =>
    createUser(q, {
      agencyId: me.agencyId,
      email: address,
      // Never shown, never stored in plaintext, never emailed. The account is
      // unreachable until they redeem the link below and choose their own.
      password: randomBytes(24).toString("base64url"),
      name,
      role,
      department,
      jobTitle,
    })
  );
  if (created.error || !created.user) {
    return { error: created.error ?? "That invitation could not be created." };
  }
  const invited = created.user;

  const { token, agencyName, inviterName } = await withSystem(async (q) => {
    const agency = await q.one<{ name: string }>(`SELECT name FROM agencies WHERE id = $1`, [
      me.agencyId,
    ]);
    const inviter = await q.one<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [
      me.userId,
    ]);
    return {
      token: await createResetToken(q, invited.id, invited.email),
      agencyName: agency?.name ?? "YourCRM",
      inviterName: inviter?.name ?? "",
    };
  });

  const link = `${await origin()}/reset-password?token=${encodeURIComponent(token)}`;
  const sent = await sendEmail({ to: invited.email, ...inviteEmail(link, inviterName, agencyName) });

  revalidateApp();

  /*
     What the inviter is told is the truth about what happened, not a cheerful
     default. Three genuinely different outcomes:

       - mail went out;
       - there is no mail provider and this is development, so the link is
         handed over directly rather than going nowhere silently;
       - mail failed in production, where the account exists and the invitation
         does not — saying "invited" there would leave somebody waiting for an
         email that is never coming.
  */
  if (sent.sent) return { ok: `${name} has been invited — the email is on its way.` };
  if (!emailConfigured() && process.env.NODE_ENV !== "production") {
    return { ok: `${name} was added. Email is not configured here, so send them this link: ${link}` };
  }
  return {
    error: `${name} was added, but the invitation email could not be sent. Ask them to use "Forgot your password?" on the sign-in page.`,
  };
}

/**
 * Change a colleague's role.
 *
 * Two separate rank checks, and the second one is easy to miss. The obvious one
 * is the role being HANDED OUT — an admin promoting somebody to owner is the
 * same self-promotion hole as inviting one. The other is the role the person
 * ALREADY HOLDS: without it an admin could demote the owner to member, which is
 * the same power in the opposite direction and would have passed, since an
 * admin outranks a member perfectly well.
 *
 * Not plan-gated. This is account administration rather than product use, and
 * an account sorting out a lapsed payment may well need to move who is in
 * charge — the same reasoning that leaves the profile and password forms open.
 */
export async function setMemberRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireTenant();
  if (!roleCan(me.role, "manage_users")) {
    return { error: "Only an owner or admin can change roles." };
  }

  const userId = validId(formData.get("userId"));
  const role = pick(formData.get("role"), ROLES);
  if (!userId) return { error: "That person could not be identified." };
  if (!role) return { error: "Choose a role." };
  if (userId === me.userId) {
    return { error: "You cannot change your own role." };
  }
  if (!outranks(me.role, role)) {
    return { error: "Only an owner can make somebody else an owner." };
  }

  const updated = await withSystem(async (q) => {
    const person = await q.one<{ name: string; role: string }>(
      `SELECT name, role FROM users WHERE id = $1 AND agency_id = $2 AND deleted_at IS NULL`,
      [userId, me.agencyId]
    );
    if (!person) return { ok: false as const, gone: true as const };
    if (!outranks(me.role, person.role)) return { ok: false as const, refused: true as const };

    const changed = await setUserRole(q, me.agencyId, userId, role);
    if (changed) return { ok: true as const, name: changed.name };
    /* The write is the guard for the last-owner rule; reaching here means it
       refused, and the only reason it can refuse a row that existed a moment
       ago is that this is the final owner. */
    return { ok: false as const, lastOwner: true as const };
  });

  if (!updated.ok) {
    if ("gone" in updated) return { error: "That person is no longer on this account." };
    if ("refused" in updated) return { error: "Only an owner can change another owner's role." };
    return { error: "This is the only owner. Make somebody else an owner first." };
  }

  revalidateApp();
  /* Phrased without an article, so the sentence does not need to know which
     role takes "a" and which takes "an" — and so this line is not a place where
     a role name is compared against a literal. */
  return { ok: `${updated.name}'s role is now ${role}.` };
}

/**
 * Remove a colleague.
 *
 * A soft delete, which also frees the address for reuse — somebody who leaves
 * and comes back is a new invitation, not a support ticket. Their records stay
 * exactly where they are: contacts and deals belong to the workspace, not to
 * whoever happened to enter them.
 *
 * Deliberately not plan-gated. Cutting off somebody's access is a security
 * control, in the same category as changing a password, and the moment it is
 * most likely to be needed — an employee leaving while the card is failing — is
 * exactly the moment a plan gate would refuse it.
 */
export async function removeMemberAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireTenant();
  if (!roleCan(me.role, "manage_users")) {
    return { error: "Only an owner or admin can remove someone." };
  }

  const userId = validId(formData.get("userId"));
  if (!userId) return { error: "That person could not be identified." };
  if (userId === me.userId) {
    return { error: "You cannot remove yourself. Ask another owner to do it." };
  }

  const outcome = await withSystem(async (q) => {
    const person = await q.one<{ name: string; role: string }>(
      `SELECT name, role FROM users WHERE id = $1 AND agency_id = $2 AND deleted_at IS NULL`,
      [userId, me.agencyId]
    );
    if (!person) return { ok: false as const, gone: true as const, name: "" };
    if (!outranks(me.role, person.role)) {
      return { ok: false as const, refused: true as const, name: person.name };
    }
    const removed = await removeTeamMember(q, me.agencyId, userId);
    /* Reaching here with `removed` false means the write's own guard refused a
       row that existed a moment ago, and the only thing that guard refuses is
       the last owner. Read from the outcome rather than from the role, so the
       message cannot claim a reason the database did not act on. */
    return { ok: removed, name: person.name };
  });

  if (!outcome.ok) {
    if ("gone" in outcome) return { error: "That person is no longer on this account." };
    if ("refused" in outcome) return { error: "Only an owner can remove another owner." };
    return { error: "This is the only owner. Make somebody else an owner first." };
  }

  revalidateApp();
  return { ok: `${outcome.name} no longer has access.` };
}

/**
 * Fill in a colleague's directory entry: department, title, phone, scope.
 *
 * None of it is a permission, and none of it is read for a decision — which is
 * why the check is `manage_users` and not something stricter. It IS somebody
 * else's record though, so the same rank rule applies as everywhere else on
 * this screen: an admin may tidy up a member's entry, not an owner's.
 *
 * Your own entry goes through the profile form under Account instead, so this
 * refuses `me` outright rather than quietly being a second way to edit
 * yourself with different validation.
 *
 * Not plan-gated, for the same reason as the profile form: a company directory
 * is account management, and correcting somebody's phone number while a payment
 * is being sorted out is not product use.
 */
export async function updateStaffAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const me = await requireTenant();
  if (!roleCan(me.role, "manage_users")) {
    return { error: "Only an owner or admin can edit somebody's details." };
  }

  const userId = validId(formData.get("userId"));
  if (!userId) return { error: "That person could not be identified." };
  if (userId === me.userId) {
    return { error: "Edit your own details under Account." };
  }

  /* Every field is sent every time, and an empty one means "cleared". That is
     why these are read as strings rather than skipped when blank: passing
     `undefined` would make the form able to fill a phone number in and never
     take it out again. */
  const patch = {
    department: text(formData.get("department"), 60),
    jobTitle: text(formData.get("jobTitle"), 80),
    phone: text(formData.get("phone"), 40),
    scope: multiline(formData.get("scope"), 400),
  };

  const outcome = await withSystem(async (q) => {
    const person = await q.one<{ name: string; role: string }>(
      `SELECT name, role FROM users WHERE id = $1 AND agency_id = $2 AND deleted_at IS NULL`,
      [userId, me.agencyId]
    );
    if (!person) return { ok: false as const, gone: true as const, name: "" };
    if (!outranks(me.role, person.role)) {
      return { ok: false as const, refused: true as const, name: person.name };
    }
    const result = await updateProfile(q, userId, patch);
    return result.user
      ? { ok: true as const, name: result.user.name }
      : { ok: false as const, failed: result.error ?? "Those details were not saved.", name: "" };
  });

  if (!outcome.ok) {
    if ("gone" in outcome) return { error: "That person is no longer on this account." };
    if ("refused" in outcome) return { error: "Only an owner can edit another owner's details." };
    return { error: outcome.failed };
  }

  revalidateApp();
  return { ok: `${outcome.name}'s details updated.` };
}
