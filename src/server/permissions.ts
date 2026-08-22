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

/** Capabilities that are decided by role rather than by plan. */
export const CAPABILITIES = ["manage_workspaces", "manage_users", "manage_billing"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Role → capability.
 *
 * A member is somebody's employee working inside one client's data. They do not
 * add workspaces (a permissions hole, and on a metered plan a bill), they do
 * not add colleagues, and they do not see the card details.
 */
const GRANTS: Record<Role, readonly Capability[]> = {
  owner: CAPABILITIES,
  admin: ["manage_workspaces", "manage_users"],
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
