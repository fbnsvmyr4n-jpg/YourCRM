import { describe, expect, it } from "vitest";
import { dealMoneyBucket } from "@/server/contact-summaries";
import { STAGES } from "@/server/repos/deals";
import { isWonStage } from "@/data/pipeline";

/**
 * The two revenue figures on a contact: Won and Open.
 *
 * Asked directly — "I can't have our users just seeing the revenue information
 * if it's not verified to be accurate and correct" — so this walks every stage
 * a deal can be in, with and without a `won_at` stamp, rather than checking the
 * happy path and trusting the rest.
 */

const WON_AT = new Date("2026-08-26T10:00:00Z");

describe("every stage lands in exactly one pot", () => {
  it("never silently drops a deal's value", () => {
    /**
     * THE BUG THIS CAUGHT. The rule was `won_at !== null` for won, else
     * `["prospect","discovery","demo"].includes(stage)` for open — and nothing
     * else. `moveDeal` only stamps `won_at` on the way into Won and preserves
     * whatever is already there for Delivery and Referral, so a deal dragged
     * straight from Demo to Delivery keeps a NULL stamp. Delivery is in neither
     * list, so its value was counted in NEITHER pot.
     *
     * Money that existed on the board and simply did not appear on the contact
     * — the exact failure the question was about. Reproduced here as
     * `dealMoneyBucket("delivery", null)`, which returned "none" and now
     * returns "won".
     */
    expect(dealMoneyBucket("delivery", null)).toBe("won");
    expect(dealMoneyBucket("referral", null)).toBe("won");
    /* And a deal recorded straight into Won without the stamp, which the
       importer and any direct create can produce. */
    expect(dealMoneyBucket("won", null)).toBe("won");
  });

  it("counts a stamped deal as won from any stage", () => {
    /* `won_at` is the fact that payment happened, and it has to survive the
       card moving on to Delivery and Referral — otherwise revenue would fall as
       the work began, which is the opposite of true. */
    for (const stage of STAGES) {
      expect(dealMoneyBucket(stage, WON_AT)).toBe("won");
    }
  });

  it("counts the pipeline stages as open", () => {
    expect(dealMoneyBucket("prospect", null)).toBe("open");
    expect(dealMoneyBucket("discovery", null)).toBe("open");
    expect(dealMoneyBucket("demo", null)).toBe("open");
  });

  it("excludes lost, and only lost", () => {
    /**
     * The one deliberate exclusion. A lost deal is neither money you have nor
     * money you might get, and counting it in either pot would overstate the
     * contact.
     *
     * Written as "the only stage that can return none" rather than a single
     * assertion about `lost`, so a stage added later cannot quietly join it.
     */
    const dropped = STAGES.filter((s) => dealMoneyBucket(s, null) === "none");
    expect(dropped).toEqual(["lost"]);
  });

  it("agrees with the rest of the app about what 'won' means", () => {
    /* `isWonStage` is the definition every other screen uses. The contact panel
       disagreeing with it is how the hole appeared in the first place. */
    for (const stage of STAGES) {
      if (isWonStage(stage)) expect(dealMoneyBucket(stage, null)).toBe("won");
    }
  });
});
