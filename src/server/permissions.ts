import { type Role } from "./tenant";

/**
 * What each role is allowed to do.
 *
 * Written as data, and read by both the server action and the component that
 * decides whether to render the form. Two inline `role !== "member"` checks
 * would be two places to change and one place to forget — and the way that
 * failure presents is a button that is visible, submits, and is refused, or
 * worse, a button that is hidden while the action behind it still works.
 *
 * Hiding a control is presentation. The refusal in the action is the security.
 * These share a source so they cannot disagree about which is which.
 */

/**
 * Powers over the ACCOUNT — its people, its client workspaces, its money.
 *
 * These are ranked: `outranks` compares two roles by asking whether one holds
 * everything the other does. Adding something here therefore changes who may
 * administer whom, which is why data access below is deliberately NOT one of
 * them.
 */
export const CAPABILITIES = ["manage_workspaces", "manage_users", "manage_billing"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Who may read and write the customer records — contacts, deals, meetings,
 * calls, messages, notes, and every report over them.
 *
 * A separate table, and the separation is the important part. This was very
 * nearly written as a fourth entry in CAPABILITIES, which would have quietly
 * broken the thing that matters most on the Team screen: `outranks` asks
 * whether the viewer holds every capability the target holds, so the moment a
 * member held `access_crm` and an admin did not, **an admin could no longer
 * manage a member**. The entire people-management screen would have stopped
 * working for exactly the role that exists to run it.
 *
 * They are different kinds of question and the code should say so. Administering
 * people is a hierarchy — more power contains less. Seeing customer data is
 * orthogonal to it: a member sees the CRM and administers nobody; an IT admin
 * administers everybody and has no business reading a customer's phone number.
 *
 * Owner sees everything because they answer for the business. Member is the
 * person actually doing the selling. Admin is IT and finance is accounts, and
 * neither needs a customer's records to do their job — which is the whole point
 * of separating them.
 */
const CRM_ACCESS: Record<Role, boolean> = {
  owner: true,
  admin: false,
  finance: false,
  member: true,
};

/**
 * May this role open the CRM at all?
 *
 * `?? false` for the same fail-closed reason as `can`: the value arrives from a
 * database column and is really whatever is in that column. An unrecognised
 * role must see no customer data rather than fall through to a default that
 * grants it.
 */
export function canAccessCrm(role: string): boolean {
  return CRM_ACCESS[role as Role] ?? false;
}

/**
 * Role → capability.
 *
 * A member is somebody's employee working inside one client's data. They do not
 * add workspaces (a permissions hole, and on a metered plan a bill), they do
 * not add colleagues, and they do not see the card details.
 *
 * `finance` is the accounts department, and it exists because the alternative
 * was worse. Billing used to be owner-only, and owner grants everything else
 * too — so letting a bookkeeper pay an invoice meant handing them the power to
 * remove the CEO. One capability, and no others.
 *
 * Nothing else had to be written for that to be safe. `outranks` below reads
 * this table, so an admin cannot act on a finance user (an admin does not hold
 * `manage_billing`) and a finance user cannot act on anybody. Only an owner
 * appoints or removes one. That is emergent, not special-cased, which is the
 * whole reason the rule is expressed as capabilities rather than as a list of
 * role names.
 */
const GRANTS: Record<Role, readonly Capability[]> = {
  owner: CAPABILITIES,
  admin: ["manage_workspaces", "manage_users"],
  finance: ["manage_billing"],
  member: [],
};

/**
 * `?? false` is not defensive padding — it is the fail-closed rule.
 *
 * `role` is typed as `Role`, but it arrives from a database column and is
 * really whatever is in that column: a typo in a migration, a value from an
 * older schema. An unrecognised role must grant nothing rather than throwing
 * or, worse, reaching a default branch that grants something.
 */
export function can(role: Role, capability: Capability): boolean {
  return GRANTS[role]?.includes(capability) ?? false;
}

/**
 * The same question, for a role that arrived as a plain string.
 *
 * Delegates rather than re-checking membership against `ROLES` first. That
 * check was there and no mutation could kill it: `can` already answers false
 * for a key the matrix does not hold, so the extra test proved nothing while
 * reading as though it were the thing keeping unknown roles out. A guard that
 * cannot fail is a guard that misdirects the next person to read it.
 */
export function roleCan(role: string, capability: Capability): boolean {
  return can(role as Role, capability);
}

/**
 * May somebody holding `viewer` administer somebody holding `target`?
 *
 * Yes exactly when the viewer holds every capability the target holds. An admin
 * therefore cannot promote, demote or remove an owner — the owner has
 * `manage_billing` and the admin does not — while an owner can act on anyone,
 * and either can act on a member.
 *
 * Derived from the matrix rather than written as `role !== "owner"`, and that is
 * the whole point. The inline version appeared in five places across the team
 * screen and its three actions, which is five copies of a rule that has to
 * agree with itself; the first time a fourth role is added, or `manage_billing`
 * moves, they stop agreeing and the way it shows is an admin quietly able to
 * remove the owner who pays the bill.
 *
 * Note this is about administering PEOPLE. Whether the viewer may manage people
 * at all is `manage_users`, and both are checked — this one never grants on its
 * own, since a member trivially outranks another member.
 */
export function outranks(viewer: string, target: string): boolean {
  return CAPABILITIES.every((c) => !roleCan(target, c) || roleCan(viewer, c));
}
