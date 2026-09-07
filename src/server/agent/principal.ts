import { canAccessCrm } from "../permissions";
import { listUsers } from "../repos/users";
import { withSystem, type TenantContext } from "../tenant";
import type { AgentPrincipal, ToolCapability } from "./gateway";

/**
 * Whose authority a voice agent borrows.
 *
 * An inbound call carries no session — it is a carrier talking to a public URL
 * — so there is nobody signed in, and yet every mutation has to be attributable
 * to a person. The specification is firm about this and so is the gateway: the
 * agent is never its own principal.
 *
 * So a call acts as a real member of the workspace it landed in, and the audit
 * trail names them. Which one is chosen deliberately:
 *
 *  1. Somebody pinned to this sub-account who can see customer records. They
 *     are the closest thing to "the person who would have answered".
 *  2. Otherwise the agency's longest-standing owner, who answers for the
 *     business anyway.
 *  3. Otherwise nobody — and the agent gets no tools at all rather than a
 *     nameless one. A workspace whose only members are IT and accounts has
 *     nobody whose authority a customer-facing agent could honestly borrow.
 */

/**
 * What a voice agent may do, at most.
 *
 * A deliberate subset, and smaller than what the person whose account it
 * borrows could do by hand. The gateway refuses anything outside it, so this
 * list is the whole answer to "what can somebody achieve by phoning the
 * number" — which is a question worth being able to answer in one place.
 *
 * `write_task` is absent because this CRM has no task entity; a follow-up here
 * is a meeting. `call_control` is absent until there are call-control tools to
 * grant.
 */
export const VOICE_CAPABILITIES: ReadonlySet<ToolCapability> = new Set([
  "read_crm",
  "write_activity",
  "write_contact",
  "write_meeting",
  "draft_quote",
]);

/** Read-only, for an agent that should identify and answer but never write. */
export const VOICE_READ_ONLY: ReadonlySet<ToolCapability> = new Set(["read_crm"]);

export async function voicePrincipal(
  ctx: TenantContext,
  callId: string,
  capabilities: ReadonlySet<ToolCapability> = VOICE_CAPABILITIES
): Promise<AgentPrincipal | null> {
  const staff = await withSystem((q) => listUsers(q, ctx.agencyId));

  /* Only somebody who could read these records themselves. Borrowing an IT
     admin's identity would give the agent an actor whose own screens refuse to
     show what the agent is about to write. */
  const eligible = staff.filter((u) => canAccessCrm(u.role));

  const pinned = eligible.find((u) => u.subAccountId === ctx.subAccountId);
  const owner = eligible.find((u) => u.role === "owner");
  const acting = pinned ?? owner ?? null;
  if (!acting) return null;

  return {
    agent: "voice",
    userId: acting.id,
    role: acting.role,
    callId,
    capabilities,
  };
}
