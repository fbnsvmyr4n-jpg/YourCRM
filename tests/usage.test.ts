import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  RATES,
  aiCostMicros,
  formatMicros,
  voiceCostMicros,
} from "../src/server/usage";
import { startTestDb, type TestDb, TENANT_A, TENANT_B } from "./helpers/pg";

/**
 * What the product costs to run, per workspace.
 *
 * The plans sell "unlimited" alongside an assistant billed per token and
 * telephony billed per minute. Nobody knows what that costs, because nothing
 * measured it — and a price set against an unmeasured cost is a guess whose
 * only symptom is the margin.
 *
 * The arithmetic gets the most attention here because it is where a pricing
 * decision would go wrong quietly. The first version of `RATES` was a hundred
 * times too cheap: micro-cents means $3 is 300,000,000, and it was written as
 * 3,000,000. Every figure would have been believable, and every one wrong.
 */

describe("the rates are the published rates", () => {
  /**
   * Checked against dollar amounts a person can verify against a price page,
   * not against the constants themselves — which would only prove the file
   * agrees with itself.
   */
  const asDollars = (micros: number) => micros / 1_000_000 / 100;

  it("charges $3 per million input tokens", () => {
    expect(asDollars(RATES.aiInputPerMillionTokens)).toBe(3);
  });

  it("charges $15 per million output tokens", () => {
    expect(asDollars(RATES.aiOutputPerMillionTokens)).toBe(15);
  });

  it("charges $0.0085 per voice minute", () => {
    expect(asDollars(RATES.voicePerMinute)).toBeCloseTo(0.0085, 6);
  });

  it("charges $0.0079 per SMS segment", () => {
    expect(asDollars(RATES.smsPerSegment)).toBeCloseTo(0.0079, 6);
  });
});

describe("an AI message costs what the tokens cost", () => {
  const asDollars = (micros: number) => micros / 1_000_000 / 100;

  it("prices a million of each at $18", () => {
    expect(asDollars(aiCostMicros(1_000_000, 1_000_000))).toBe(18);
  });

  it("prices a realistic message at about a cent and a third", () => {
    // ~2,000 tokens of CRM context in, ~500 out. This is the number that
    // decides whether "unlimited" at $97 survives contact with a busy account.
    expect(asDollars(aiCostMicros(2000, 500))).toBeCloseTo(0.0135, 6);
  });

  it("does not round a real cost away to zero", () => {
    // The whole reason for micro-cents. In whole cents this is 0, and a
    // thousand of them would still be 0.
    expect(aiCostMicros(100, 20)).toBeGreaterThan(0);
  });

  it("costs nothing when nothing was used", () => {
    expect(aiCostMicros(0, 0)).toBe(0);
  });

  it("never returns a negative cost", () => {
    // A bad token count from an API change must not credit the account.
    expect(aiCostMicros(-500, -100)).toBe(0);
  });

  it("charges output five times input, as the rates say", () => {
    // Output dominates the bill on a chatty assistant. If these ever invert,
    // every projection built on this number is wrong in the expensive
    // direction.
    expect(aiCostMicros(0, 1000)).toBe(aiCostMicros(5000, 0));
  });
});

describe("a voice minute costs what the carrier charges", () => {
  it("bills a whole minute for a whole minute", () => {
    expect(voiceCostMicros(60)).toBe(RATES.voicePerMinute);
  });

  it("rounds a part minute up, as carriers do", () => {
    /**
     * A 20-second call costs a full minute. Recording it as a third would
     * under-report telephony by two-thirds and make it look cheap enough to
     * bundle — which is exactly the decision this data is meant to inform.
     */
    expect(voiceCostMicros(20)).toBe(RATES.voicePerMinute);
    expect(voiceCostMicros(61)).toBe(2 * RATES.voicePerMinute);
    expect(voiceCostMicros(120)).toBe(2 * RATES.voicePerMinute);
  });

  it("costs nothing for a call that never connected", () => {
    expect(voiceCostMicros(0)).toBe(0);
  });

  it("never returns a negative cost", () => {
    expect(voiceCostMicros(-30)).toBe(0);
  });
});

describe("money is shown honestly", () => {
  it("shows nothing as nothing", () => {
    expect(formatMicros(0)).toBe("$0.00");
  });

  it("shows a real but tiny cost as tiny, not as zero", () => {
    // "$0.00" beside a hundred AI messages reads as a broken counter. It is
    // also the number somebody would use to conclude the feature is free.
    expect(formatMicros(aiCostMicros(100, 20))).toBe("<$0.01");
  });

  it("shows an ordinary amount as money", () => {
    expect(formatMicros(1_000_000 * 100 * 4.5)).toBe("$4.50");
  });
});

/* ------------------------------------------------------------------ */
/* Against a real database                                            */
/* ------------------------------------------------------------------ */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let recordUsage: typeof import("../src/server/usage").recordUsage;
let usageThisMonth: typeof import("../src/server/usage").usageThisMonth;
let closePool: typeof import("../src/server/db").closePool;

const ctx = (subAccountId: string) => ({
  agencyId: "ag_test",
  subAccountId,
  userId: "u_test_a",
  role: "owner" as const,
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ recordUsage, usageThisMonth } = await import("../src/server/usage"));
  ({ closePool } = await import("../src/server/db"));
});

afterAll(async () => {
  await closePool();
  await db.stop();
});

beforeEach(() => db.seed(`DELETE FROM usage_events`));

describe("usage is recorded against the workspace that generated it", () => {
  it("totals a month of AI messages", async () => {
    await withTenant(ctx(TENANT_A), async (q) => {
      await recordUsage(q, { kind: "ai_message", quantity: 1, costMicros: aiCostMicros(2000, 500) });
      await recordUsage(q, { kind: "ai_message", quantity: 1, costMicros: aiCostMicros(2000, 500) });
    });

    const summary = await withTenant(ctx(TENANT_A), (q) => usageThisMonth(q));
    const ai = summary.lines.find((l) => l.kind === "ai_message");
    expect(ai?.events).toBe(2);
    expect(ai?.costMicros).toBe(2 * aiCostMicros(2000, 500));
  });

  it("keeps kinds apart, and totals across them", async () => {
    await withTenant(ctx(TENANT_A), async (q) => {
      await recordUsage(q, { kind: "ai_message", quantity: 1, costMicros: 1000 });
      await recordUsage(q, { kind: "voice_minute", quantity: 3, costMicros: 2000 });
    });

    const summary = await withTenant(ctx(TENANT_A), (q) => usageThisMonth(q));
    expect(summary.lines.length).toBe(2);
    expect(summary.lines.find((l) => l.kind === "voice_minute")?.quantity).toBe(3);
    expect(summary.totalCostMicros).toBe(3000);
  });

  it("belongs to one workspace", async () => {
    /**
     * The reason this is tenant-scoped rather than per-agency: an agency
     * reselling to its clients needs to know WHICH client is generating the
     * cost. A total across all of them is unbillable and, shown to a client,
     * discloses how busy the others are.
     */
    await withTenant(ctx(TENANT_A), (q) =>
      recordUsage(q, { kind: "ai_message", quantity: 1, costMicros: 500 })
    );
    await withTenant(ctx(TENANT_B), (q) =>
      recordUsage(q, { kind: "ai_message", quantity: 1, costMicros: 9999 })
    );

    const a = await withTenant(ctx(TENANT_A), (q) => usageThisMonth(q));
    const b = await withTenant(ctx(TENANT_B), (q) => usageThisMonth(q));
    expect(a.totalCostMicros, "one workspace saw another's costs").toBe(500);
    expect(b.totalCostMicros).toBe(9999);
  });

  it("ignores usage from previous months", async () => {
    await withTenant(ctx(TENANT_A), (q) =>
      recordUsage(q, { kind: "ai_message", quantity: 1, costMicros: 700 })
    );
    await db.seed(
      `UPDATE usage_events SET occurred_at = date_trunc('month', now()) - interval '1 day'`
    );

    const summary = await withTenant(ctx(TENANT_A), (q) => usageThisMonth(q));
    expect(summary.totalCostMicros, "last month's cost was counted as this month's").toBe(0);
  });

  it("counts an event from the first instant of the month", async () => {
    // The boundary in the direction that loses data: an exclusive lower bound
    // silently drops everything recorded at midnight on the 1st.
    await withTenant(ctx(TENANT_A), (q) =>
      recordUsage(q, { kind: "ai_message", quantity: 1, costMicros: 700 })
    );
    await db.seed(`UPDATE usage_events SET occurred_at = date_trunc('month', now())`);

    const summary = await withTenant(ctx(TENANT_A), (q) => usageThisMonth(q));
    expect(summary.totalCostMicros).toBe(700);
  });

  it("is empty, not broken, for a workspace that has used nothing", async () => {
    const summary = await withTenant(ctx(TENANT_B), (q) => usageThisMonth(q));
    expect(summary.lines).toEqual([]);
    expect(summary.totalCostMicros).toBe(0);
  });

  it("does not fail the customer's request when recording fails", async () => {
    /**
     * The accounting must never break the feature. The customer's answer is
     * already in hand by the time this runs; losing a row costs a fraction of a
     * cent of accuracy, while throwing costs them the thing they asked for.
     */
    await expect(
      withTenant(ctx(TENANT_A), (q) =>
        // A kind the CHECK constraint refuses.
        recordUsage(q, { kind: "not_a_kind" as never, quantity: 1, costMicros: 1 })
      )
    ).resolves.toBeUndefined();
  });
});

describe("the paths that cost money are metered", () => {
  const SRC = join(__dirname, "..", "src");

  const walk = (dir: string): string[] =>
    !existsSync(dir)
      ? []
      : readdirSync(dir).flatMap((f) => {
          const full = join(dir, f);
          if (statSync(full).isDirectory()) return walk(full);
          return f.endsWith(".ts") ? [full] : [];
        });

  it("the AI assistant records what it spent", () => {
    /**
     * Metered from the response's own token counts, not estimated from the
     * question's length. An estimate would be a number that looks like a
     * measurement and is not — which on a pricing decision is worse than having
     * no number at all.
     */
    const src = readFileSync(join(SRC, "server", "chat-agent.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "the AI path no longer records usage").toMatch(/recordUsage\(/);
    expect(code, "the cost is not taken from the reported token counts").toMatch(
      /response\.usage\?\.(input|output)_tokens/
    );
  });

  it("the telephony path records what it spent", () => {
    const src = readFileSync(join(SRC, "app", "api", "voice", "[action]", "route.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "completed calls are no longer metered").toMatch(/recordUsage\(/);
    expect(code).toMatch(/voiceCostMicros\(/);
  });

  it("nothing outside the meter invents a cost", () => {
    // Costs come from `usage.ts`. A rate copied into a page or an action is a
    // second source of truth that will disagree the first time either changes.
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith(join("server", "usage.ts")))
      .filter((f) => /aiInputPerMillionTokens|voicePerMinute\s*[:=]\s*\d/.test(readFileSync(f, "utf8")));
    expect(offenders, "a rate is defined outside usage.ts").toEqual([]);
  });
});
