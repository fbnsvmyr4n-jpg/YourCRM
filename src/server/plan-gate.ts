import { entitlementsFor, explain } from "./entitlements";
import { logDenied } from "./log";
import { withSystem } from "./tenant";

/**
 * Whether an account may still use the product.
 *
 * Until now entitlements were consulted in exactly one place — creating a
 * sub-account — and displayed in one more. Everything else ignored them, so a
 * cancelled subscription and an expired trial both kept the entire CRM. That is
 * the leak the whole of Phase 5 exists to close, and it was still open after
 * the plans, the trials and the Stripe wiring were all working.
 *
 * The gate lives at the two entry points every request already passes through
 * rather than in each action. The audit's finding was that 31 actions shipped
 * without an authorisation check because the check was something a developer
 * had to remember; adding a second thing to remember, at the same 49 call
 * sites, would produce the same outcome.
 *
 * What a lapsed account can still do, and why each:
 *
 *  - **Reach Settings and pay.** Locking somebody out of the page where they
 *    would fix the problem turns a lapsed card into a lost customer.
 *  - **Sign out.**
 *  - **Keep their data.** Nothing is deleted, hidden, or exported away. They
 *    are asked to choose a plan, not punished.
 */

export class PlanInactiveError extends Error {
  /** The message a person should see — names what happened and what to do. */
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "PlanInactiveError";
    this.reason = reason;
  }
}

export type PlanState = { active: boolean; reason: string };

/**
 * Is this agency's plan in force?
 *
 * Takes the agency id rather than reading a session, so the decision is
 * testable without standing up a request — the same reasoning as
 * `resolveSubAccount`, and for the same reason: a control that is awkward to
 * test is one that ends up untested, which on this project has meant one that
 * ends up broken.
 */
export async function planState(agencyId: string): Promise<PlanState> {
  const entitlements = await withSystem((q) => entitlementsFor(q, agencyId));

  // `crm` is the feature every plan grants and nothing else gates. Asking about
  // it rather than about `active` alone means a future plan that genuinely does
  // not include the CRM is handled by the same path.
  const allowed = explain(entitlements, "crm");
  if (allowed.allowed) return { active: true, reason: "" };

  return { active: false, reason: allowed.reason };
}

/** Throws when the plan is not in force. For server actions. */
export async function requireActivePlan(agencyId: string, surface: string): Promise<void> {
  const state = await planState(agencyId);
  if (state.active) return;

  logDenied("plan-gate", `${surface}: ${state.reason}`);
  throw new PlanInactiveError(state.reason);
}
