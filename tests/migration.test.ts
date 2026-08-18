import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers/pg";

/**
 * The migration, rehearsed.
 *
 * These are not "does it run" tests. A migration that runs and quietly mangles
 * ten records is worse than one that crashes, because the crash is noticed. So
 * the cases here are the ones where a mistake is silent and permanent:
 * duplicated people, money off by a factor of a hundred, a "won" deal with no
 * date, a partial payment losing the amount that was actually owed.
 *
 * Run against a real Postgres with the real schema — including the triggers and
 * constraints, which are part of what the migration has to satisfy.
 */

let db: TestDb;
let withSystem: typeof import("../src/server/tenant").withSystem;
let run: typeof import("../src/server/migrate/run");
let closePool: typeof import("../src/server/db").closePool;

const AG = "ag_migrated";
const SA = "sa_migrated";

const opts = {
  agencyId: AG,
  agencyName: "YourCRM",
  subAccountId: SA,
  subAccountName: "Main workspace",
  // Stated, not guessed — see toTimestamp. Africa/Johannesburg is UTC+2.
  legacyTimeZone: "Africa/Johannesburg",
};

const emptyLegacy = {
  contacts: [],
  leads: [],
  deals: [],
  meetings: [],
  messages: [],
};

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  run = await import("../src/server/migrate/run");
});

afterAll(async () => {
  await closePool();
  await db.stop();
});

beforeEach(() =>
  db.seed(`DELETE FROM deals; DELETE FROM meetings; DELETE FROM messages;
           DELETE FROM contacts; DELETE FROM settings;
           DELETE FROM sub_accounts WHERE id = '${SA}';
           DELETE FROM agencies WHERE id = '${AG}';`)
);

type Legacy = Parameters<typeof run.migrate>[1];
const go = (legacy: Partial<Legacy>) =>
  withSystem((q) => run.migrate(q, { ...emptyLegacy, ...legacy } as Legacy, opts));

const rows = <T extends Record<string, unknown>>(sql: string) =>
  withSystem((q) => q.rows<T>(sql));

describe("the tenant root is created once", () => {
  it("makes the existing workspace agency #1 and its primary sub-account", async () => {
    await go({});
    const sub = await rows<{ id: string; is_primary: boolean }>(
      `SELECT id, is_primary FROM sub_accounts WHERE id = '${SA}'`
    );
    expect(sub[0]).toMatchObject({ id: SA, is_primary: true });
  });

  it("is safe to run twice", async () => {
    // Re-running after a partial failure must not double every record. Every
    // insert is ON CONFLICT DO NOTHING and every id is derived, never random.
    const legacy = {
      contacts: [{ id: "c1", firstName: "Ada", lastName: "Lovelace", email: "ada@x.test" }],
      deals: [{ id: "d1", title: "A deal", value: 1000, stage: "won", wonAt: "2026-01-01T00:00:00Z" }],
    };
    await go(legacy);
    await go(legacy);

    expect((await rows(`SELECT id FROM contacts`)).length).toBe(1);
    expect((await rows(`SELECT id FROM deals`)).length).toBe(1);
  });
});

describe("money survives the move", () => {
  it("converts whole units to cents exactly once", async () => {
    /**
     * The mistake that is invisible until someone reads a total: the legacy
     * store held whole currency units, the new one holds cents. Applied twice
     * or not at all, every figure in the product is wrong by 100×.
     */
    await go({ deals: [{ id: "d1", title: "Deal", value: 2500, stage: "won", wonAt: "2026-01-01T00:00:00Z" }] });
    const [d] = await rows<{ value_cents: string }>(`SELECT value_cents FROM deals WHERE id = 'd1'`);
    expect(d.value_cents).toBe("250000");
  });

  it("keeps a partial payment's original contract value", async () => {
    // Without split_total, a £10,000 part-payment is indistinguishable from a
    // £10,000 deal paid in full. The column exists because this migration would
    // otherwise have dropped it.
    await go({
      deals: [
        { id: "d1", title: "Paid part", value: 4000, stage: "won", wonAt: "2026-01-01T00:00:00Z", splitId: "s1", splitTotal: 10000 },
        { id: "d2", title: "Still owed", value: 6000, stage: "negotiation", splitId: "s1", splitTotal: 10000 },
      ],
    });
    const got = await rows<{ id: string; split_id: string; split_total_cents: string }>(
      `SELECT id, split_id, split_total_cents FROM deals ORDER BY id`
    );
    expect(got.map((r) => r.split_id)).toEqual(["s1", "s1"]);
    expect(got[0].split_total_cents).toBe("1000000");
  });

  it("totals to the same amount it started with", async () => {
    const deals = [
      { id: "d1", title: "A", value: 1234.56, stage: "won", wonAt: "2026-01-01T00:00:00Z" },
      { id: "d2", title: "B", value: 99.99, stage: "proposal" },
      { id: "d3", title: "C", value: 0, stage: "lead" },
    ];
    await go({ deals });
    const v = await withSystem((q) => run.verify(q, { ...emptyLegacy, deals } as Legacy, SA));
    const money = v.checks.find((c) => c.name === "deal value in cents")!;
    expect(money.ok, `expected ${money.expected} cents, got ${money.actual}`).toBe(true);
  });
});

describe("leads and contacts are merged, not duplicated", () => {
  it("merges a lead into the contact with the same email", async () => {
    /**
     * The whole reason for the fold. The same human existed in both tables,
     * joined by nothing, and a migration that copied both would carve the
     * duplicate permanently into the new schema.
     */
    await go({
      contacts: [{ id: "c1", firstName: "Ada", lastName: "Lovelace", email: "ada@x.test" }],
      leads: [{ id: "l1", name: "Ada Lovelace", email: "ada@x.test", status: "New Lead", source: "Referral" }],
    });

    const people = await rows<{ id: string }>(`SELECT id FROM contacts`);
    expect(people.length, "the same person was migrated twice").toBe(1);

    // And the lead's position is preserved as a deal against that same person.
    const [deal] = await rows<{ contact_id: string; stage: string; source: string }>(
      `SELECT contact_id, stage, source FROM deals`
    );
    expect(deal).toMatchObject({ contact_id: "c1", stage: "prospect", source: "referral" });
  });

  it("merges on name when neither side has an email", async () => {
    await go({
      contacts: [{ id: "c1", firstName: "Grace", lastName: "Hopper" }],
      leads: [{ id: "l1", name: "Grace Hopper", status: "New Lead" }],
    });
    expect((await rows(`SELECT id FROM contacts`)).length).toBe(1);
  });

  it("refuses to merge two people who share a name but not an email", async () => {
    /**
     * Deliberately conservative. A duplicate is visible and fixable; a wrong
     * merge destroys one person's history inside another's and nothing says it
     * happened. When the emails actively disagree, they are different humans.
     */
    await go({
      contacts: [{ id: "c1", firstName: "John", lastName: "Smith", email: "john@alpha.test" }],
      leads: [{ id: "l1", name: "John Smith", email: "john@beta.test", status: "New Lead" }],
    });
    expect((await rows(`SELECT id FROM contacts`)).length, "two different people were merged").toBe(2);
  });

  it("refuses to guess when two contacts share an email", async () => {
    // That is itself a duplicate; picking one would be a coin toss.
    await go({
      contacts: [
        { id: "c1", firstName: "Sam", lastName: "One", email: "same@x.test" },
        { id: "c2", firstName: "Sam", lastName: "Two", email: "same@x.test" },
      ],
      leads: [{ id: "l1", name: "Sam Someone", email: "same@x.test", status: "New Lead" }],
    });
    expect((await rows(`SELECT id FROM contacts`)).length).toBe(3);
  });

  it("carries a lead with no matching contact across as a new person", async () => {
    const report = await go({
      leads: [{ id: "l1", name: "New Person", email: "new@x.test", status: "Follow-up Required", source: "Facebook" }],
    });
    expect(report.leadsMerged).toBe(0);

    const [c] = await rows<{ first_name: string; last_name: string }>(`SELECT first_name, last_name FROM contacts`);
    expect(c).toMatchObject({ first_name: "New", last_name: "Person" });

    const [d] = await rows<{ stage: string; source: string }>(`SELECT stage, source FROM deals`);
    expect(d).toMatchObject({ stage: "discovery", source: "facebook" });
  });

  it("handles a one-word name without inventing a surname", async () => {
    await go({ leads: [{ id: "l1", name: "Cher", status: "New Lead" }] });
    const [c] = await rows<{ first_name: string; last_name: string }>(`SELECT first_name, last_name FROM contacts`);
    expect(c).toMatchObject({ first_name: "Cher", last_name: "" });
  });
});

describe("stages and outcomes are translated, not assumed", () => {
  it("maps the old pipeline onto the six real stages", async () => {
    await go({
      deals: [
        { id: "d1", title: "A", stage: "lead" },
        { id: "d2", title: "B", stage: "qualified" },
        { id: "d3", title: "C", stage: "proposal" },
        { id: "d4", title: "D", stage: "negotiation" },
        { id: "d5", title: "E", stage: "won", wonAt: "2026-01-01T00:00:00Z" },
      ],
    });
    const got = await rows<{ id: string; stage: string }>(`SELECT id, stage FROM deals ORDER BY id`);
    expect(got.map((d) => d.stage)).toEqual(["prospect", "discovery", "demo", "demo", "won"]);
  });

  it("does not invent a close date for a won deal that never recorded one", async () => {
    /**
     * A deal sitting in the won column with no timestamp is not evidence it was
     * won on any particular day. Filling in `now()` would put historical
     * revenue in this week and make the trend line a lie.
     */
    await go({ deals: [{ id: "d1", title: "Old win", value: 500, stage: "won" }] });
    const [d] = await rows<{ stage: string; won_at: Date | null }>(`SELECT stage, won_at FROM deals`);
    expect(d.stage).toBe("won");
    expect(d.won_at, "a close date was invented").toBeNull();
  });

  it("renames meeting outcomes to the values the schema accepts", async () => {
    // "no-show" vs "no_show" — the drift that already existed between the old
    // repo and the schema. A straight copy would violate the CHECK constraint.
    await go({
      meetings: [
        { id: "m1", date: "2026-03-01", time: "10:30", outcome: "no-show", topic: "Missed" },
        { id: "m2", date: "2026-03-02", time: "2:00 pm", outcome: "lost", lossReason: "Price", topic: "Lost one" },
      ],
    });
    const got = await rows<{ id: string; outcome: string; loss_reason: string | null }>(
      `SELECT id, outcome, loss_reason FROM meetings ORDER BY id`
    );
    expect(got[0].outcome).toBe("no_show");
    expect(got[1]).toMatchObject({ outcome: "lost", loss_reason: "Price" });
  });

  it("combines a date and a 12-hour time into the right instant", async () => {
    await go({ meetings: [{ id: "m1", date: "2026-03-01", time: "2:00 pm", topic: "Afternoon" }] });
    const [m] = await rows<{ scheduled_at: Date }>(`SELECT scheduled_at FROM meetings`);
    expect(new Date(m.scheduled_at).getUTCHours(), "2pm in UTC+2 should be 12:00 UTC").toBe(12);
  });

  it("reports a meeting with no usable date instead of dropping it silently", async () => {
    const report = await go({ meetings: [{ id: "m1", topic: "When?" }] });
    expect((await rows(`SELECT id FROM meetings`)).length).toBe(0);
    expect(report.warnings.join(" "), "a skipped record was not reported").toMatch(/m1.*skipped/);
  });

  it("reports an unrecognised stage rather than filing it quietly", async () => {
    const report = await go({ deals: [{ id: "d1", title: "Odd", stage: "haggling" }] });
    expect(report.warnings.join(" ")).toMatch(/unknown stage "haggling"/);
    expect((await rows<{ stage: string }>(`SELECT stage FROM deals`))[0].stage).toBe("prospect");
  });
});

describe("messages keep their meaning", () => {
  it("rejoins the body so it classifies exactly as it did before", async () => {
    await go({
      messages: [
        { id: "m1", subject: "Could we book a demo?", body: ["Hello there", "Could we book a time?"], direction: "received", unread: true, at: "2026-03-01T09:00:00Z" },
      ],
    });
    const [m] = await rows<{ body: string; unread: boolean }>(`SELECT body, unread FROM messages`);
    expect(m.body).toBe("Hello there\n\nCould we book a time?");
    expect(m.unread).toBe(true);
  });

  it("turns a trashed message into a tombstone, which is what the bin was", async () => {
    await go({
      messages: [{ id: "m1", subject: "Binned", direction: "received", trashed: true, at: "2026-03-01T09:00:00Z" }],
    });
    const [m] = await rows<{ deleted_at: Date | null }>(`SELECT deleted_at FROM messages`);
    expect(m.deleted_at, "a binned message came back as live mail").not.toBeNull();
  });
});

describe("settings stop being global", () => {
  it("attaches the target to the sub-account, in cents", async () => {
    await go({ settings: { monthlyTarget: 50_000, weeklyCapacity: 25 } } as Partial<Legacy>);
    const [s] = await rows<{ sub_account_id: string; monthly_target_cents: string; weekly_capacity: number }>(
      `SELECT sub_account_id, monthly_target_cents, weekly_capacity FROM settings`
    );
    expect(s).toMatchObject({ sub_account_id: SA, monthly_target_cents: "5000000", weekly_capacity: 25 });
  });
});

describe("verification is independent of the migration", () => {
  it("passes on a faithful run", async () => {
    const legacy = {
      ...emptyLegacy,
      contacts: [{ id: "c1", firstName: "Ada", lastName: "L", email: "ada@x.test" }],
      leads: [{ id: "l1", name: "Bob Other", email: "bob@x.test", status: "New Lead" }],
      deals: [{ id: "d1", title: "A", value: 100, stage: "won", wonAt: "2026-01-01T00:00:00Z" }],
      meetings: [{ id: "m1", date: "2026-03-01", time: "10:00", topic: "T" }],
      messages: [{ id: "msg1", subject: "S", direction: "received", at: "2026-03-01T09:00:00Z" }],
    } as Legacy;

    await go(legacy);
    const v = await withSystem((q) => run.verify(q, legacy, SA));
    expect(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok))).toBe(true);
  });

  it("reports skipped meetings as a shortfall instead of expecting them to be missing", async () => {
    /**
     * The check that was structurally incapable of failing. It compared the
     * result against the same filter the migration uses to skip undated rows,
     * so it passed while dropping 5 of 22 real meetings in the production
     * rehearsal. A check derived from the behaviour it checks cannot fail.
     */
    const legacy = {
      ...emptyLegacy,
      meetings: [
        { id: "m1", date: "2026-03-01", time: "10:00", topic: "Dated" },
        { id: "m2", time: "10:00", topic: "No date at all" },
      ],
    } as Legacy;

    await go(legacy);
    const v = await withSystem((q) => run.verify(q, legacy, SA, opts.legacyTimeZone));

    expect(v.ok, "losing a meeting was reported as success").toBe(false);
    expect(v.checks.find((c) => c.name === "meetings")).toMatchObject({ expected: 2, actual: 1 });
    expect(v.checks.find((c) => c.name === "meetings skipped (no date)")).toMatchObject({
      expected: 0,
      actual: 1,
      ok: false,
    });
  });

  it("fails when rows are missing, rather than trusting the migration's own count", async () => {
    /**
     * The check that matters. Every insert uses ON CONFLICT DO NOTHING, so a
     * write can succeed and change nothing — and the report would still say it
     * wrote the row. Verification re-counts from the database against the
     * source documents, so a silent no-op shows up.
     */
    const legacy = {
      ...emptyLegacy,
      deals: [
        { id: "d1", title: "A", value: 100, stage: "lead" },
        { id: "d2", title: "B", value: 200, stage: "lead" },
      ],
    } as Legacy;

    await go(legacy);
    await db.seed(`DELETE FROM deals WHERE id = 'd2'`);

    const v = await withSystem((q) => run.verify(q, legacy, SA));
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.name === "deals")).toMatchObject({ expected: 2, actual: 1, ok: false });
  });
});

describe("the old data is left alone", () => {
  it("never writes to crm_collections", async () => {
    // The rollback is "point the app back at the old path", not "restore from a
    // backup". That only holds if the migration reads and never writes.
    const src = (await import("node:fs")).readFileSync(
      (await import("node:path")).join(__dirname, "..", "src", "server", "migrate", "run.ts"),
      "utf8"
    );
    expect(src).toMatch(/SELECT data FROM crm_collections/);
    expect(src, "the migration modifies the legacy store").not.toMatch(
      /(INSERT INTO|UPDATE|DELETE FROM)\s+crm_collections/i
    );
  });
});
