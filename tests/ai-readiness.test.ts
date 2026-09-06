import { afterEach, describe, expect, it } from "vitest";
import { aiConfigured, quotationReadiness } from "../src/server/ai";

/**
 * Whether the quotation feature can actually happen, and whether anybody is
 * told when it cannot.
 *
 * Both of its dependencies fail quietly. Without a model the assistant falls
 * back to the deterministic one — which still answers real questions from real
 * data, so the page looks entirely healthy while the one thing a person asks
 * for silently does not happen. Without email a quotation is drafted, approved
 * and stamped with a name, and no client ever receives it.
 *
 * That second case is the one these tests exist for. It is the same shape as
 * billing's dangerous state, where a Stripe key without a webhook secret
 * charges customers and activates no accounts: half-configured is worse than
 * unconfigured, because everything visible keeps working.
 */

const original = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = original;
});

describe("whether there is a model behind the assistant", () => {
  it("is false when the key is absent", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(aiConfigured()).toBe(false);
  });

  it("is false when the key is set to whitespace", () => {
    /* An empty or blank variable is SET as far as `process.env` is concerned
       and absent as far as the API is concerned. The chat page read the raw
       variable with `!!`, so a stray `ANTHROPIC_API_KEY=` in an environment
       file would have lit the green "Online" dot on a page whose assistant
       cannot call a model. */
    process.env.ANTHROPIC_API_KEY = "   ";
    expect(aiConfigured()).toBe(false);
  });

  it("is true for a real value", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key";
    expect(aiConfigured()).toBe(true);
  });
});

describe("what the health check says about quotations", () => {
  it("says so plainly when both halves are configured", () => {
    expect(quotationReadiness(true, true)).toMatch(/^ok:/);
  });

  it("calls out an agent that can draft and no way to send", () => {
    // The dangerous one: approving works, so nothing on screen suggests the
    // client never got it.
    const said = quotationReadiness(true, false);
    expect(said).toMatch(/HALF CONFIGURED/);
    expect(said).toMatch(/no client will receive anything/);
    expect(said).toMatch(/RESEND_API_KEY/);
  });

  it("does not call it broken when only the agent is missing", () => {
    // Writing quotations by hand is the product working, not failing — the
    // price list and the document screens stand on their own.
    const said = quotationReadiness(false, true);
    expect(said).not.toMatch(/HALF CONFIGURED/);
    expect(said).toMatch(/manual only/);
    expect(said).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("says both are missing rather than picking one", () => {
    const said = quotationReadiness(false, false);
    expect(said).toMatch(/neither/i);
  });

  it("names the variable to set in every state that is not ok", () => {
    /* A health line that reports a problem without naming its cause sends
       somebody to grep the codebase. */
    for (const [ai, mail] of [
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      expect(quotationReadiness(ai, mail)).toMatch(/ANTHROPIC_API_KEY|RESEND_API_KEY|assistant/);
    }
  });
});
