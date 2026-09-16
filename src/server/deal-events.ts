import type { TenantQuery } from "./tenant";
import type { DealRecord, Stage } from "./repos/deals";

/**
 * Something happened to a deal that a rule might care about.
 *
 * Raised by the deals repository itself, at the two places a lead can be born
 * and a deal can change stage, rather than by each screen that does those
 * things. There are six ways a lead gets created today — the Leads form, the
 * Deals board, the website enquiry, the voice agent, a referral, a quotation
 * drafted in Chat — and an automation that only ran for the ones somebody
 * remembered to wire up would be wrong in exactly the cases nobody watches.
 *
 * ── Why a listener rather than a direct call ─────────────────────────────
 *
 * `repos/deals.ts` is imported by client components (the board reads its stage
 * list), so anything it imports by value ends up in the browser bundle. The
 * automation engine is server code. This module has no imports at runtime, so
 * the repository can raise events without dragging the engine into the client,
 * and `tenant.ts` — which only the server ever loads — imports the engine, which
 * registers itself here. A test pins that import, because a listener nobody
 * registered fails by doing nothing.
 */

export type DealEvent =
  | { kind: "lead_created"; deal: DealRecord }
  | { kind: "deal_stage_changed"; deal: DealRecord; from: Stage };

/**
 * The rules that have already acted in the change being processed, oldest
 * first. A rule that moves a deal raises another event; this is how the engine
 * knows it is looking at its own consequence.
 */
export type Chain = readonly string[];

type Listener = (q: TenantQuery, event: DealEvent, chain: Chain) => Promise<void>;

let listener: Listener | null = null;

export function listenForDealEvents(fn: Listener): void {
  listener = fn;
}

/** Runs inside the caller's transaction, so what a rule does commits with it. */
export async function emitDealEvent(q: TenantQuery, event: DealEvent, chain: Chain = []): Promise<void> {
  if (listener) await listener(q, event, chain);
}
