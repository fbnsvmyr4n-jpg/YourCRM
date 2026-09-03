import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B, AGENCY, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The deals repository: Bradley's six stages, against real Postgres.
 *
 * The cases that matter here are not CRUD. They are the ones where the previous
 * version's analytics went untrue — a pipeline that ended at the sale, a Win
 * Rate with no losing state, and revenue attributed by matching names. Each of
 * those is a rule about how a row must stay consistent with itself, so each
 * gets a test rather than a comment.
 *
 * Note what these run against: RLS is bypassed in this harness (see
 * `helpers/pg.ts`), so the isolation cases below are proving the repository's
 * own predicates under the same conditions a superuser connection would face.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let repo: typeof import("../src/server/repos/deals");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/deals");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

const make = (over: Partial<Parameters<typeof repo.createDeal>[1]> = {}) =>
  inA((q) => repo.createDeal(q, { title: "A deal", valueCents: 250_000, ...over }));

describe("creating and reading", () => {
  it("round-trips a deal and defaults to the first stage", async () => {
    const d = await make({ title: "  Website rebuild  " });
    expect(d.title, "input was not trimmed").toBe("Website rebuild");
    expect(d.stage).toBe("prospect");
    expect(d.valueCents).toBe(250_000);
    expect(d.wonAt).toBeNull();

    const read = await inA((q) => repo.getDeal(q, d.id));
    expect(read?.id).toBe(d.id);
  });

  it("returns money as a number, not the string Postgres sends for BIGINT", async () => {
    // node-pg hands back int8 as a string to protect precision. Left unconverted
    // it does not fail — it concatenates, so two deals of £2,500 total "250000250000".
    const d = await make({ valueCents: 900_000 });
    const read = await inA((q) => repo.getDeal(q, d.id));
    expect(typeof read?.valueCents).toBe("number");
    expect(read!.valueCents + 1).toBe(900_001);
  });

  it("lists a contact's deals", async () => {
    await db.seed(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name)
       VALUES ('c_owner', '${TENANT_A}', 'Deal', 'Owner') ON CONFLICT DO NOTHING`
    );
    const d = await make({ contactId: "c_owner" });
    const list = await inA((q) => repo.listDealsForContact(q, "c_owner"));
    expect(list.map((x) => x.id)).toContain(d.id);
  });
});

describe("money is whole cents or it is rejected", () => {
  it("refuses a fractional value", async () => {
    // Loudly, rather than rounding: a rounded figure is wrong in a way nobody
    // notices until it is reconciled against a bank statement.
    await expect(make({ valueCents: 1234.56 })).rejects.toThrow(/whole cents/i);
  });

  it("refuses a negative value", async () => {
    await expect(make({ valueCents: -100 })).rejects.toThrow(/negative/i);
  });

  it("refuses a value beyond safe integer precision", async () => {
    await expect(make({ valueCents: Number.MAX_SAFE_INTEGER + 2 })).rejects.toThrow(/range/i);
  });

  it("rejects a fractional value on update too", async () => {
    const d = await make();
    await expect(inA((q) => repo.updateDeal(q, d.id, { valueCents: 0.5 }))).rejects.toThrow(
      /whole cents/i
    );
  });
});

describe("the pipeline does not end at the sale", () => {
  it("stamps won_at when the deal is won", async () => {
    const d = await make();
    const won = await inA((q) => repo.moveStage(q, d.id, "won"));
    expect(won?.stage).toBe("won");
    expect(won?.wonAt, "a won deal has no won_at, so revenue cannot see it").not.toBeNull();
  });

  it("keeps won_at through Delivery and Referral", async () => {
    /**
     * The rule the old pipeline got wrong. Delivery and Referral are post-close
     * in Bradley's process; if winning were read from the stage, revenue would
     * fall the moment delivery began — success would look like a loss.
     */
    const d = await make();
    const won = await inA((q) => repo.moveStage(q, d.id, "won"));
    const delivered = await inA((q) => repo.moveStage(q, d.id, "delivery"));
    expect(delivered?.wonAt).toBe(won?.wonAt);

    const referred = await inA((q) => repo.moveStage(q, d.id, "referral"));
    expect(referred?.wonAt, "the sale un-happened when the client referred someone").toBe(
      won?.wonAt
    );
  });

  it("clears won_at when the deal moves back before the close", async () => {
    // The opposite case: the sale genuinely un-happened, so revenue must stop
    // counting it rather than keep a stale timestamp.
    const d = await make();
    await inA((q) => repo.moveStage(q, d.id, "won"));
    const back = await inA((q) => repo.moveStage(q, d.id, "discovery"));
    expect(back?.wonAt, "a deal back in Discovery is still counted as revenue").toBeNull();
  });

  it("does not restamp won_at when a won deal is re-saved as won", async () => {
    const d = await make();
    const first = await inA((q) => repo.moveStage(q, d.id, "won"));
    const again = await inA((q) => repo.moveStage(q, d.id, "won"));
    expect(again?.wonAt, "the close date moved").toBe(first?.wonAt);
  });
});

describe("losing a deal is a first-class outcome", () => {
  it("requires a reason", async () => {
    // Without this the loss analysis is built from whichever losses somebody
    // happened to annotate, which is worse than having no analysis.
    const d = await make();
    await expect(inA((q) => repo.moveStage(q, d.id, "lost"))).rejects.toThrow(/reason/i);
    await expect(inA((q) => repo.moveStage(q, d.id, "lost", { lostReason: "   " }))).rejects.toThrow(
      /reason/i
    );
  });

  it("records the reason and clears any won timestamp", async () => {
    const d = await make();
    await inA((q) => repo.moveStage(q, d.id, "won"));
    const lost = await inA((q) => repo.moveStage(q, d.id, "lost", { lostReason: "Went in-house" }));
    expect(lost?.lostReason).toBe("Went in-house");
    expect(lost?.wonAt, "a lost deal still counts as revenue").toBeNull();
  });

  it("clears the reason when a lost deal is revived", async () => {
    const d = await make();
    await inA((q) => repo.moveStage(q, d.id, "lost", { lostReason: "No budget" }));
    const revived = await inA((q) => repo.moveStage(q, d.id, "discovery"));
    expect(revived?.lostReason, "a live deal still carries a loss reason").toBeNull();
  });

  it("refuses a stage it does not recognise", async () => {
    const d = await make();
    await expect(
      inA((q) => repo.moveStage(q, d.id, "negotiating" as never))
    ).rejects.toThrow(/stage/i);
  });
});

describe("pain points drive the demo", () => {
  it("captures them and appends without overwriting", async () => {
    const d = await make({ painPoints: ["Losing leads to slow follow-up"] });
    const after = await inA((q) => repo.addPainPoints(q, d.id, ["No visibility of pipeline"]));
    expect(after?.painPoints).toEqual([
      "Losing leads to slow follow-up",
      "No visibility of pipeline",
    ]);
  });

  it("accumulates across separate calls rather than replacing", async () => {
    /**
     * Read-modify-write is what lost 18 of 20 records on the old store: two
     * people finishing discovery calls on the same deal would each write back
     * the array they read, and the second would silently erase the first.
     *
     * True concurrency cannot be exercised here — PGlite's socket server
     * accepts one connection at a time, and a parallel call fails with
     * ECONNRESET before it reaches Postgres. So this proves accumulation, and
     * the test below proves the mechanism: the append happens inside the UPDATE
     * statement, where the row is locked, rather than in JavaScript. Those two
     * together are the guarantee; neither alone would be.
     */
    const d = await make({ painPoints: ["first"] });
    await inA((q) => repo.addPainPoints(q, d.id, ["second"]));
    await inA((q) => repo.addPainPoints(q, d.id, ["third"]));
    const after = await inA((q) => repo.getDeal(q, d.id));
    expect(after?.painPoints).toEqual(["first", "second", "third"]);
  });

  it("appends inside the UPDATE, never by reading the array into JavaScript", async () => {
    // The mechanism the test above depends on. `pain_points || $n::jsonb` is
    // evaluated against the locked row; a read-then-write in application code
    // would reintroduce the lost-update bug no matter how the caller behaves.
    const src = readFileSync(
      join(__dirname, "..", "src", "server", "repos", "deals.ts"),
      "utf8"
    );
    expect(src).toMatch(/pain_points\s*=\s*pain_points\s*\|\|/);
  });

  it("ignores blank input rather than storing empty strings", async () => {
    const d = await make({ painPoints: [] });
    const after = await inA((q) => repo.addPainPoints(q, d.id, ["  ", ""]));
    expect(after?.painPoints).toEqual([]);
  });
});

describe("attribution is a column, not a name match", () => {
  it("stores the source on the deal", async () => {
    const d = await make({ source: "google_ads" });
    expect((await inA((q) => repo.getDeal(q, d.id)))?.source).toBe("google_ads");
  });

  it("records who referred the deal, closing the loop back to Prospect", async () => {
    await db.seed(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name)
       VALUES ('c_referrer', '${TENANT_A}', 'Happy', 'Client') ON CONFLICT DO NOTHING`
    );
    const d = await make({ source: "referral", referredByContactId: "c_referrer" });
    const read = await inA((q) => repo.getDeal(q, d.id));
    expect(read?.referredByContactId).toBe("c_referrer");
  });

  it("survives the referrer being renamed", async () => {
    // The whole point of the fold: the old model matched by name, so a rename
    // severed the link silently and only 4 of 10 won deals could be attributed.
    await db.seed(
      `INSERT INTO contacts (id, sub_account_id, first_name, last_name)
       VALUES ('c_rename', '${TENANT_A}', 'Before', 'Rename') ON CONFLICT DO NOTHING`
    );
    const d = await make({ source: "referral", referredByContactId: "c_rename" });
    await db.seed(`UPDATE contacts SET last_name = 'Renamed' WHERE id = 'c_rename'`);
    expect((await inA((q) => repo.getDeal(q, d.id)))?.referredByContactId).toBe("c_rename");
  });
});

describe("stage changes go through moveStage only", () => {
  it("updateDeal cannot set a stage behind moveStage's back", async () => {
    // A plain assignment would skip the won_at and lost_reason side effects and
    // leave the row disagreeing with itself.
    const d = await make();
    await inA((q) => repo.updateDeal(q, d.id, { stage: "won" } as never));
    expect((await inA((q) => repo.getDeal(q, d.id)))?.stage).toBe("prospect");
  });

  it("updates the fields it is given and leaves the rest", async () => {
    const d = await make({ title: "Keep", valueCents: 111 });
    const up = await inA((q) => repo.updateDeal(q, d.id, { title: "Changed" }));
    expect(up?.title).toBe("Changed");
    expect(up?.valueCents, "an unmentioned field was blanked").toBe(111);
  });
});

describe("deletion is soft and reversible", () => {
  it("hides the deal and restores it", async () => {
    const d = await make();
    expect(await inA((q) => repo.deleteDeal(q, d.id))).toBe(true);
    expect(await inA((q) => repo.getDeal(q, d.id))).toBeNull();
    expect(await inA((q) => repo.restoreDeal(q, d.id))).toBe(true);
    expect(await inA((q) => repo.getDeal(q, d.id))).not.toBeNull();
  });

  it("reports false rather than throwing for a deal that is not there", async () => {
    expect(await inA((q) => repo.deleteDeal(q, "nope"))).toBe(false);
  });
});

describe("part-payments split a deal without losing the remainder", () => {
  /**
   * The figure that makes this worth testing: without `split_total`, a £4,000
   * payment against a £10,000 job is indistinguishable from a £4,000 job paid
   * in full, and £6,000 quietly leaves the pipeline.
   */
  // This file does not clear deals between tests — most cases here do not care.
  // These do: they count rows, and leftovers from earlier tests were being
  // counted as extra split records. Cleared per test rather than weakening the
  // assertions, because "how many won records exist" is the thing under test.
  beforeEach(() => db.seed(`DELETE FROM deals`));

  const presented = () => make({ title: "Big job", valueCents: 1_000_000, stage: "demo" });

  it("moves what was paid to won and leaves the rest outstanding", async () => {
    const d = await presented();
    const result = await inA((q) => repo.recordPayment(q, d.id, 400_000));
    expect(result.ok).toBe(true);

    const all = await inA((q) => repo.listDeals(q));
    const split = all.filter((x) => x.splitId !== null);
    expect(split, "the deal did not split in two").toHaveLength(2);

    const won = split.find((x) => x.wonAt !== null)!;
    const owed = split.find((x) => x.wonAt === null)!;
    expect(won.valueCents).toBe(400_000);
    expect(owed.valueCents, "the outstanding balance is wrong").toBe(600_000);
    // Both halves remember the original contract value.
    expect(won.splitTotalCents).toBe(1_000_000);
    expect(owed.splitTotalCents).toBe(1_000_000);
    expect(won.splitId).toBe(owed.splitId);
  });

  it("tops up the same won record on a second payment", async () => {
    // Rather than scattering one job across three cards.
    const d = await presented();
    await inA((q) => repo.recordPayment(q, d.id, 400_000));
    await inA((q) => repo.recordPayment(q, d.id, 100_000));

    const all = await inA((q) => repo.listDeals(q));
    const won = all.filter((x) => x.wonAt !== null && x.splitId !== null);
    expect(won, "a second payment created a second won record").toHaveLength(1);
    expect(won[0].valueCents).toBe(500_000);
    expect(all.find((x) => x.id === d.id)?.valueCents).toBe(500_000);

    /**
     * The contract value must still be the ORIGINAL, not what was outstanding
     * when the second payment arrived. Recomputing it here would shrink
     * £10,000 to £6,000, and a job that is half paid would render as one paid
     * in full — the precise confusion this column exists to prevent. A
     * mutation doing exactly that passed the whole suite before this line.
     */
    expect(won[0].splitTotalCents, "the contract value shrank").toBe(1_000_000);
    expect(all.find((x) => x.id === d.id)?.splitTotalCents).toBe(1_000_000);
  });

  it("closes the original when the balance reaches zero", async () => {
    // Otherwise a fully paid job sits in the pipeline forever at £0, inflating
    // the count of open work.
    const d = await presented();
    await inA((q) => repo.recordPayment(q, d.id, 1_000_000));

    expect(await inA((q) => repo.getDeal(q, d.id)), "the settled deal is still open").toBeNull();
    const won = (await inA((q) => repo.listDeals(q))).filter((x) => x.wonAt !== null);
    expect(won).toHaveLength(1);
    expect(won[0].valueCents).toBe(1_000_000);
  });

  /**
   * Taking a payment back out.
   *
   * The board records money in one tap now, with no confirmation in front of
   * it. That is only defensible because it is reversible, so these are the
   * tests that hold the tap up — an undo that half-works would leave the
   * business's own revenue figure wrong.
   *
   * Both branches of `recordPayment` need an inverse, so both get a case.
   */
  describe("undoing one", () => {
    it("puts a fully paid deal back exactly as it was", async () => {
      const d = await presented();
      const paid = await inA((q) => repo.recordPayment(q, d.id, 1_000_000));
      expect(await inA((q) => repo.getDeal(q, d.id)), "setup: it should be closed").toBeNull();

      const undone = await inA((q) => repo.undoPayment(q, paid.wonDealId!, 1_000_000));
      expect(undone.ok).toBe(true);

      const back = await inA((q) => repo.getDeal(q, d.id));
      expect(back, "the deal was not restored").not.toBeNull();
      expect(back!.valueCents, "it came back for the wrong money").toBe(1_000_000);
      expect(back!.stage).toBe("demo");
      expect(back!.wonAt, "it came back already won").toBeNull();

      /* And the money is gone from the won column, not merely hidden. This is
         what Reports counts as revenue. */
      const won = (await inA((q) => repo.listDeals(q))).filter((x) => x.wonAt !== null);
      expect(won, "the won record survived the undo").toHaveLength(0);
    });

    it("takes only that payment off a part-paid deal", async () => {
      /* Two payments against one job, undoing the second. The won record must
         come DOWN by the second amount rather than disappearing and taking the
         first payment with it. */
      const d = await presented();
      await inA((q) => repo.recordPayment(q, d.id, 400_000));
      const second = await inA((q) => repo.recordPayment(q, d.id, 100_000));

      const undone = await inA((q) => repo.undoPayment(q, second.wonDealId!, 100_000));
      expect(undone.ok).toBe(true);

      const all = await inA((q) => repo.listDeals(q));
      const won = all.filter((x) => x.wonAt !== null && x.splitId !== null);
      expect(won, "the first payment was destroyed too").toHaveLength(1);
      expect(won[0].valueCents, "the wrong amount came off").toBe(400_000);
      expect(all.find((x) => x.id === d.id)?.valueCents, "the balance is wrong").toBe(600_000);
    });

    it("cannot be run twice", async () => {
      // The bar can be tapped again before it clears, and a second undo would
      // otherwise take the money off a deal that never received it.
      const d = await presented();
      const paid = await inA((q) => repo.recordPayment(q, d.id, 1_000_000));
      await inA((q) => repo.undoPayment(q, paid.wonDealId!, 1_000_000));

      const again = await inA((q) => repo.undoPayment(q, paid.wonDealId!, 1_000_000));
      expect(again.error, "the undo ran a second time").toBeTruthy();
      expect(await inA((q) => repo.getDeal(q, d.id))).not.toBeNull();
      expect((await inA((q) => repo.listDeals(q))).filter((x) => x.wonAt !== null)).toHaveLength(0);
    });

    it("refuses to take out more than went in", async () => {
      const d = await presented();
      const paid = await inA((q) => repo.recordPayment(q, d.id, 400_000));
      const r = await inA((q) => repo.undoPayment(q, paid.wonDealId!, 900_000));
      expect(r.error, "an inflated undo was accepted").toBeTruthy();
      expect(
        (await inA((q) => repo.listDeals(q))).find((x) => x.id === d.id)?.valueCents,
        "the deal was changed by a refused undo"
      ).toBe(600_000);
    });

    it("refuses the id of a deal that is not a payment", async () => {
      /**
       * The open half of a part-paid deal carries the same split id as the won
       * half, so it is the one wrong id that gets far enough to do damage:
       * without the `won_at` check this function would find it, treat it as the
       * record the money went into, and then look up the deal it was paid
       * against — finding ITSELF. It would take the amount off that row and add
       * it straight back, leaving a payment that reports as undone and money
       * still counted as revenue.
       *
       * A mutation removing that check survived every other case here.
       */
      const d = await presented();
      await inA((q) => repo.recordPayment(q, d.id, 400_000));

      const r = await inA((q) => repo.undoPayment(q, d.id, 400_000));
      expect(r.error, "an open deal was accepted as a payment").toBeTruthy();

      const all = await inA((q) => repo.listDeals(q));
      expect(all.find((x) => x.id === d.id)?.valueCents, "the open half was changed").toBe(600_000);
      const won = all.filter((x) => x.wonAt !== null && x.splitId !== null);
      expect(won, "the payment was destroyed").toHaveLength(1);
      expect(won[0].valueCents, "the recorded payment changed").toBe(400_000);
    });

    it("belongs to the tenant that made the payment", async () => {
      /* The id travels to the browser and comes back, so it is exactly the
         thing another account would try to name. */
      const d = await presented();
      const paid = await inA((q) => repo.recordPayment(q, d.id, 1_000_000));

      const r = await inB((q) => repo.undoPayment(q, paid.wonDealId!, 1_000_000));
      expect(r.error, "another tenant undid this payment").toBeTruthy();
      expect(await inA((q) => repo.getDeal(q, d.id)), "tenant A's deal was restored by tenant B").toBeNull();
    });
  });

  describe("a loss is dated, the way a win is", () => {
    /**
     * Win Rate is `won / (won + lost)`. Both halves have to be dateable or a
     * rate over a period cannot be computed: with only `won_at`, Reports
     * filtered the numerator to the window and measured it against every loss
     * the account had ever recorded.
     *
     * These read the column directly. The report-level tests pass without the
     * stamping working at all, because `lost_count` also filters on
     * `stage = 'lost'` — so the stage alone carries them, and a mutation that
     * never stamped `lost_at` survived the whole suite.
     */
    const lostAt = async (id: string) =>
      (
        await inA((q) =>
          q.one<{ lost_at: Date | null }>(
            `SELECT lost_at FROM deals WHERE id = $2 AND sub_account_id = $1`,
            [q.ctx.subAccountId, id]
          )
        )
      )?.lost_at ?? null;

    it("stamps the moment a deal is marked lost", async () => {
      const d = await presented();
      expect(await lostAt(d.id), "setup: it should not be dated yet").toBeNull();

      const before = Date.now();
      await inA((q) => repo.moveStage(q, d.id, "lost", { lostReason: "Price" }));
      const at = await lostAt(d.id);

      expect(at, "a lost deal was left without a date").not.toBeNull();
      // Generous either side: this is proving it is real, not measuring a clock.
      expect(at!.getTime()).toBeGreaterThanOrEqual(before - 60_000);
      expect(at!.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    });

    it("clears it when the deal comes back out of Lost", async () => {
      /* Otherwise a revived deal carries a loss date forever, and any later
         report that counts by date rather than by stage counts it twice — once
         as a loss and once as whatever it became. */
      const d = await presented();
      await inA((q) => repo.moveStage(q, d.id, "lost", { lostReason: "Price" }));
      expect(await lostAt(d.id)).not.toBeNull();

      await inA((q) => repo.moveStage(q, d.id, "demo"));
      expect(await lostAt(d.id), "a revived deal kept its loss date").toBeNull();
    });

    it("keeps the original date when a lost deal is re-saved as lost", async () => {
      // The date belongs to the event, not to the last time somebody touched
      // the row — the same rule `won_at` follows.
      const d = await presented();
      await inA((q) => repo.moveStage(q, d.id, "lost", { lostReason: "Price" }));
      const first = await lostAt(d.id);

      await inA((q) => repo.moveStage(q, d.id, "lost", { lostReason: "Competitor chosen" }));
      expect((await lostAt(d.id))?.getTime(), "the loss date moved").toBe(first?.getTime());
    });
  });

  it("refuses more than is outstanding", async () => {
    const d = await presented();
    const r = await inA((q) => repo.recordPayment(q, d.id, 1_500_000));
    expect(r.error).toMatch(/more than/i);
    expect((await inA((q) => repo.getDeal(q, d.id)))?.valueCents).toBe(1_000_000);
  });

  it("refuses zero, a negative, and a fractional amount", async () => {
    const d = await presented();
    for (const bad of [0, -100, 1.5]) {
      expect((await inA((q) => repo.recordPayment(q, d.id, bad))).error).toMatch(/greater than zero/i);
    }
  });

  it("refuses payment against a deal nobody has presented to", async () => {
    // Taking money against an untouched prospect means the board is not
    // describing anything that happened.
    const d = await make({ stage: "prospect", valueCents: 100_000 });
    expect((await inA((q) => repo.recordPayment(q, d.id, 50_000))).error).toMatch(/Discovery or Demo/i);
  });

  it("refuses another tenant's deal", async () => {
    const d = await presented();
    expect((await inB((q) => repo.recordPayment(q, d.id, 100_000))).error).toMatch(/no longer exists/i);
    expect((await inA((q) => repo.getDeal(q, d.id)))?.valueCents).toBe(1_000_000);
  });
});

describe("the tenant boundary holds", () => {
  it("hides another tenant's deals from every read", async () => {
    const d = await make();
    expect(await inB((q) => repo.getDeal(q, d.id))).toBeNull();
    expect((await inB((q) => repo.listDeals(q))).some((x) => x.id === d.id)).toBe(false);
  });

  it("refuses every write from another tenant", async () => {
    const d = await make({ title: "Mine" });
    expect(await inB((q) => repo.updateDeal(q, d.id, { title: "Stolen" }))).toBeNull();
    expect(await inB((q) => repo.moveStage(q, d.id, "won"))).toBeNull();
    expect(await inB((q) => repo.addPainPoints(q, d.id, ["injected"]))).toBeNull();
    expect(await inB((q) => repo.deleteDeal(q, d.id))).toBe(false);

    const mine = await inA((q) => repo.getDeal(q, d.id));
    expect(mine?.title, "another tenant modified this deal").toBe("Mine");
    expect(mine?.stage).toBe("prospect");
    expect(mine?.painPoints).toEqual([]);
  });
});
