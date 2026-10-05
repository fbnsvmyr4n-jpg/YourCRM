/**
 * What a write answers when nobody is holding a form.
 *
 * The forms in this product already answer in one readable shape per area —
 * `LeadResult`, `DealResult`, `MeetingResult`, `NoteResult` — because a screen
 * that cannot tell a refusal from a success will show a success.
 * `refusals-are-visible.test.ts` holds each of them to it.
 *
 * This is the same contract for the OTHER half: the ticks, the toggles and the
 * deletes. A tick is not a form, so it was never part of that pass, and nine of
 * them threw the answer away.
 *
 * ── Why this needed a type and not just a `if` at each caller ──────────────
 *
 * `withCurrentTenant` refuses a view-only reader with `return { error: … } as
 * T`. The cast is what makes it work for every action regardless of what that
 * action returns — and it is also why these nine looked correct. An action
 * declared `Promise<void>` really does hand back `{ error: … }` at run time,
 * but TypeScript has been told it returns nothing, so a caller inspecting the
 * result is writing code the compiler says is dead. Nobody writes that.
 *
 * So the fix is not "remember to check". It is to stop the type lying: an
 * action that can be refused says so in its signature, and then checking it is
 * the obvious thing rather than the clever thing.
 */
export type WriteResult = { ok: true } | { error: string };

/**
 * Was this write refused? Narrows the refusal for the caller.
 *
 * Takes `unknown` on purpose. A refusal can come back from an action typed to
 * return a `WriteResult`, an area's own result type, a record, or nothing at
 * all — `withCurrentTenant` casts `{ error: … }` onto whatever the action
 * declares. One predicate that reads any of them beats four narrower ones that
 * each cover a third of the call sites.
 */
export function refused(result: unknown): result is { error: string } {
  return typeof result === "object" && result !== null && "error" in result;
}
