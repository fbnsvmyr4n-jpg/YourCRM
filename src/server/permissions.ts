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
  /* Sees the records — that is the job — and changes none of them. */
  viewer: true,
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
 * Who may see the MONEY DOCUMENTS: quotations, purchase orders, invoices, and
 * the payments against them.
 *
 * A third table rather than a wider reading of the one above, because the two
 * questions have different answers for the same person. Asked as one boolean,
 * the bookkeeper lost: every document in this product sits behind the CRM gate,
 * so a finance user could connect a card processor and pay this product's own
 * subscription, and could not open a single invoice showing money owed TO the
 * business. They would have to ask a salesperson to read the figures out —
 * which is more work for two people than for the one who could have done it
 * alone.
 *
 * It is a separate tier, not "finance also gets the CRM". What they get is the
 * document and the name and address printed on it. Not that contact's calls,
 * not their notes, not the pipeline. Enough to chase an invoice and reconcile a
 * payment, and nothing that is somebody else's relationship with a customer.
 */
const MONEY_ACCESS: Record<Role, boolean> = {
  owner: true,
  /* IT fixes the machine; what the business charges is not theirs to read. */
  admin: false,
  finance: true,
  /* Sales quote and invoice — that is the job. Whether they may declare one
     PAID by hand is a different question, answered by `canSettleInvoice`. */
  member: true,
  viewer: true,
};

export function canAccessMoney(role: string): boolean {
  return MONEY_ACCESS[role as Role] ?? false;
}

/**
 * Who may see HOW THE MACHINE IS RUNNING: deliveries that failed, jobs stuck in
 * the queue, the audit trail — the "is it broken, and why" view.
 *
 * IT could administer people and workspaces and was handed an empty
 * notification bell, because the bell was gated on customer-record access. So
 * "three emails could not be sent" and "a booking confirmation died in the
 * queue" were invisible to the one role whose job that is, and the product told
 * them everything was fine while it was not.
 *
 * None of it carries record CONTENT: a failed send names the document and the
 * reason the provider gave, never what the document said.
 */
const OPS_ACCESS: Record<Role, boolean> = {
  owner: true,
  admin: true,
  /* Accounts are not on call for a stuck queue. */
  finance: false,
  member: false,
  viewer: false,
};

export function canAccessOps(role: string): boolean {
  return OPS_ACCESS[role as Role] ?? false;
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
  viewer: [],
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
 * May this reader change anything at all?
 *
 * The one place the word "viewer" is compared, so the screens and the server
 * cannot drift apart — the same rule `roleCan` exists for, and the one the
 * guard suite enforces by refusing an inline `role === "viewer"` anywhere else.
 *
 * It decides PRESENTATION only: which buttons are worth offering. What actually
 * stops a viewer writing is the read-only transaction `withCurrentTenant` opens
 * for them, and that holds whatever any screen does.
 */
export function canWrite(role: string): boolean {
  return canAccessCrm(role) && role !== "viewer";
}

/**
 * Is this reader ACTUALLY view-only — able to look at the product and change
 * nothing in it?
 *
 * Not the same question as `canWrite`, and conflating them told a lie.
 * `canWrite` means "may change customer records", so it is false for finance
 * and for IT — who have no business in the pipeline — and the shell was using
 * it to decide whether to print "View only, and changes are not saved" across
 * the top of every page. A bookkeeper who settles invoices and manages the
 * billing was being told their work would not save.
 *
 * Only the viewer role is view-only. Finance and IT write plenty; they write
 * elsewhere.
 */
export function isViewOnly(role: string): boolean {
  return role === "viewer";
}

/**
 * Who may declare an invoice PAID by hand.
 *
 * Not the person who sold the work. Confirming that money arrived is how
 * revenue becomes real in this product — it moves the document, the project's
 * figures and every report built over them — and the oldest control in
 * bookkeeping is that whoever chased the sale is not whoever confirms the
 * payment.
 *
 * It costs sales nothing in practice. A card payment confirms itself through
 * the provider's webhook, so a hand-marked invoice is the exception: a transfer
 * somebody has watched land in the account, which is finance's desk by
 * definition.
 */
export function canSettleInvoice(role: string): boolean {
  return roleCan(role, "manage_billing");
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
