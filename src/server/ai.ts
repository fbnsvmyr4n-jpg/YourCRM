/**
 * Whether there is a model behind the assistant.
 *
 * One function rather than three inline reads of `process.env`, for the same
 * reason `emailConfigured()` and `stripeConfigured()` exist: the question is
 * asked from the chat page, from the agent itself and from the health check,
 * and three copies of a truth is how two of them end up disagreeing.
 *
 * It matters more since the assistant learned to draft quotations. Without a
 * key the chat agent silently falls back to the deterministic assistant, which
 * answers real questions from real data but has no tools and **cannot draft
 * anything** — so the price list is on screen, the feature is documented, and
 * the one thing a person asks for does not happen. That is the quiet
 * half-configured state this codebase keeps designing against.
 *
 * Trimmed, because an environment variable set to an empty string is set as far
 * as `process.env` is concerned and absent as far as the API is concerned.
 */
export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * Whether a quotation can actually make it from a question to a client.
 *
 * A pure function of the two flags, and separate from the health route so the
 * four states can be read — and tested — without standing up a database. The
 * one that earns it is `ai && !mail`: an assistant that drafts and no way to
 * send. A workspace in that state approves quotations that reach nobody, and
 * because approving *works* — the name is stamped, the status moves — there is
 * nothing on screen to suggest the client never got it.
 *
 * The same shape as billing's dangerous state, where a secret key without a
 * webhook secret charges customers and activates no accounts. Half-configured
 * beats unconfigured for making people trust something that is not happening.
 */
export function quotationReadiness(ai: boolean, mail: boolean): string {
  if (ai && mail) return "ok: the agent can draft, and an approved quotation can be sent";
  if (ai) {
    return (
      "HALF CONFIGURED: the agent can draft quotations but none can be sent — " +
      "approvals will be recorded and no client will receive anything (RESEND_API_KEY unset)"
    );
  }
  if (mail) {
    return "manual only: quotations must be written by hand, but they can be sent (ANTHROPIC_API_KEY unset)";
  }
  return "manual only, and unsendable: neither the assistant nor email is configured";
}
