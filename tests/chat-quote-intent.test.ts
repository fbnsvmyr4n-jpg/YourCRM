import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * Asking for a quotation when the assistant cannot draft one.
 *
 * Reported from production: "I tried to generate a quote and it couldn't."
 * Both reasons were real and neither was a bug — no model was configured, and
 * the price list was empty — but the assistant said none of that. The request
 * fell through to "I'm not certain what you're after", which is how a feature
 * that is merely switched off comes to look broken.
 *
 * These tests are about the ANSWER, not the drafting: the deterministic
 * assistant is the one a workspace without a key actually talks to, so it is
 * the one that has to explain itself.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let answer: typeof import("../src/server/chat-agent").answer;
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = {
  agencyId: AGENCY,
  subAccountId: TENANT_A,
  userId: USER_A,
  role: "owner",
};
const ask = (question: string) =>
  withTenant(ctx, (q) => answer(q, question, [], "Bradley")).then((r) => r.text);

beforeAll(async () => {
  db = await startTestDb();
  /* No key: this whole file is about the assistant a workspace without one
     gets. `answer` reads the variable at call time, so it must be absent. */
  delete process.env.ANTHROPIC_API_KEY;
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  ({ answer } = await import("../src/server/chat-agent"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM price_items; DELETE FROM documents;`));

describe("asking for a quote with no model configured", () => {
  it("says the assistant is not switched on, rather than shrugging", async () => {
    const said = await ask("can you draft a quotation for the Heineken job");
    expect(said).toMatch(/isn't switched on/i);
    /* The old behaviour, and the thing being fixed. */
    expect(said).not.toMatch(/not certain what you're after/i);
  });

  it("names who can fix it", async () => {
    const said = await ask("generate a quote");
    expect(said).toMatch(/owner/i);
  });

  it("mentions the empty price list as well, since both are needed", async () => {
    const said = await ask("quote this client");
    expect(said).toMatch(/price list/i);
  });

  it("recognises the request however it is phrased", async () => {
    for (const phrasing of [
      "quote",
      "send a quote",
      "create a quotation",
      "can you give me an estimate",
      "I need to generate a quote for them",
    ]) {
      expect(await ask(phrasing), `"${phrasing}" was not understood`).toMatch(
        /quotation|quote/i
      );
    }
  });

  it("does not steal a question that belongs to another topic", async () => {
    /* "proposal" and "price" are deliberately not keywords: they already
       belong to deals, and taking them would break an answer that worked. */
    const deals = await ask("how are my deals going");
    expect(deals).not.toMatch(/isn't switched on/i);
    const pipeline = await ask("what is my pipeline worth");
    expect(pipeline).not.toMatch(/isn't switched on/i);
  });
});

describe("asking for a quote with a model but no prices", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-one";
  });
  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("explains that a quote's figures come from the price list", async () => {
    /* The live agent would normally handle this, but it is unreachable here —
       there is no real key — so the fallback answers, which is exactly the
       path a misconfigured workspace takes. What matters is that the answer
       names the price list rather than failing vaguely. */
    const said = await ask("draft a quotation");
    expect(said).toMatch(/price list/i);
  });
});

describe("when a key is set but the model refuses it", () => {
  beforeEach(() => {
    /* A key that is present and wrong — a placeholder left in an environment
       file, an expired key, a typo. The SDK is reached and rejects it. */
    process.env.ANTHROPIC_API_KEY = "PASTE_HERE";
  });
  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("does not offer to draft in the same breath as apologising", async () => {
    /*
       Seen for real. `aiLive` means "a key is set", not "the model answered",
       so the reply said it could not reach the AI service and then offered to
       draft a quotation two lines below. One of those is wrong and the reader
       cannot tell which.
    */
    const said = await ask("draft a quotation");
    expect(said).toMatch(/couldn't reach the AI service/i);
    expect(said).not.toMatch(/I can draft a quotation from your price list/i);
  });

  it("still answers the question it can answer", async () => {
    /* Falling back is not the same as giving up: the deterministic answer is
       still real data, and losing it would make a bad key a broken assistant. */
    const said = await ask("what is my pipeline worth");
    expect(said).toMatch(/couldn't reach the AI service/i);
    expect(said).toMatch(/pipeline/i);
  });
});
