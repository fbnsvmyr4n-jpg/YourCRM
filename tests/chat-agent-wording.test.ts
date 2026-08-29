import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What the assistant sounds like.
 *
 * These answers are the product speaking, and a seam in one of them reads as
 * "this is a template" rather than "this looked at my data" — which is the
 * whole claim the chat page makes.
 */

const agent = readFileSync(
  fileURLToPath(new URL("../src/server/chat-agent.ts", import.meta.url)),
  "utf8"
);
const code = agent.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("subject and verb agree", () => {
  it("says '1 contact has bought', not '1 contact have bought'", () => {
    /**
     * Caught in a screen recording on a real account: the noun was pluralised
     * and the verb was not, so a single client rendered as "1 contact have
     * bought". Both have to switch together.
     */
    expect(code).toMatch(/clients === 1 \? " has" : "s have"/);
    /* And the broken shape is gone rather than merely shadowed. */
    expect(code).not.toMatch(/contact\$\{clients === 1 \? "" : "s"\} have/);
  });

  it("still pluralises the noun", () => {
    /* The fix must not solve agreement by dropping the plural — "2 contact has
       bought" trades one seam for another. */
    expect(code).toMatch(/\$\{clients\} contact\$\{/);
  });
});
