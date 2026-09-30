import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import { CONFIDENT, rankIntents } from "../src/server/chat-intents";
import { INTENTS } from "../src/server/chat-answers";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * What the assistant says, against figures worked out by hand.
 *
 * The Chat page tells people "answers come from your own contacts, deals and
 * meetings — nothing is estimated". That is a checkable promise and nobody had
 * checked it. Asked the ten questions a business owner actually asks, against
 * the audit fixture, on 2026-09-30. Five answers were wrong, and the worst two
 * were wrong in the way that does not look wrong:
 *
 *   - the win rate divided by EVERY deal instead of the decided ones, so it
 *     answered "43% (3 won of 7 deals)" while Reports, three clicks away, said
 *     75% of 4 decided. Naming the denominator made it more convincing;
 *   - "what invoices are outstanding" had no invoice data behind it at all, so
 *     it scored the follow-ups intent at 0.707 and answered a question about
 *     money with a list of people.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let answer: typeof import("../src/server/chat-agent").answer;
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const ask = (question: string) =>
  withTenant(ctx, (q: TenantQuery) => answer(q, question, [], "Bradley")).then((r) => r.text);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  ({ answer } = await import("../src/server/chat-agent"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

/** Three won, one lost, three open — so 75% of four decided, not 43% of seven. */
beforeEach(() =>
  db.seed(`
    DELETE FROM invoice_payments; DELETE FROM document_lines; DELETE FROM documents;
    DELETE FROM meetings; DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES
      ('c_won1', '${TENANT_A}', 'Amara', 'Dube'),
      ('c_won2', '${TENANT_A}', 'Lindiwe', 'Khumalo'),
      ('c_lost', '${TENANT_A}', 'Thandi', 'Nkosi'),
      ('c_open', '${TENANT_A}', 'Pieter', 'Venter');
    INSERT INTO deals (id, sub_account_id, contact_id, title, value_cents, stage, won_at, lost_at, lost_reason) VALUES
      ('d_w1', '${TENANT_A}', 'c_won1', 'Roof',  12000000, 'won',      now(), NULL, NULL),
      ('d_w2', '${TENANT_A}', 'c_won2', 'Fence',  8000000, 'won',      now(), NULL, NULL),
      ('d_w3', '${TENANT_A}', 'c_won1', 'Paving', 6000000, 'delivery', now(), NULL, NULL),
      ('d_l1', '${TENANT_A}', 'c_lost', 'Pool',   5000000, 'lost',     NULL,  now(), 'price'),
      ('d_o1', '${TENANT_A}', 'c_open', 'Deck',   3000000, 'prospect', NULL,  NULL, NULL);
  `)
);

describe("the figures the assistant states", () => {
  it("DIVIDES THE WIN RATE BY DECIDED DEALS, not by every deal on file", async () => {
    /* Three won, one lost, one open. 3/4 = 75%. Counting the open one as a
       loss gives 60% and falls every time work is added. */
    const text = await ask("What is my win rate?");
    expect(text, text).toMatch(/75%/);
    expect(text, "the open deal was counted as a loss").not.toMatch(/60%/);
  });

  it("names the denominator it actually used", async () => {
    expect(await ask("What is my win rate?")).toMatch(/4 decided/);
  });

  it("agrees with the pipeline and revenue figures beside it", async () => {
    const text = await ask("What is my win rate?");
    /* Won is every deal with a recorded win, including delivery. The symbol is
       left out on purpose: this harness has no settings row so it formats in
       the default currency, and what is being checked is the arithmetic. */
    expect(text).toMatch(/260,000/);
    expect(text).toMatch(/30,000/);
  });
});

describe("questions about money owed", () => {
  beforeEach(() =>
    db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party, due_on, sent_at) VALUES
        ('doc_due',  '${TENANT_A}', 'd_w1', 'invoice', 'INV-1002', 'sent', 'Ben Cole', '2026-09-25', now()),
        ('doc_paid', '${TENANT_A}', 'd_w2', 'invoice', 'INV-1001', 'sent', 'Amara Dube', '2026-09-01', now());
      INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position) VALUES
        ('dl1', '${TENANT_A}', 'doc_due',  'Paving', 1, 1500000, 0),
        ('dl2', '${TENANT_A}', 'doc_paid', 'Roof',   1, 2000000, 0);
      INSERT INTO invoice_payments (id, sub_account_id, document_id, amount_cents, provider, reference, currency, paid_at) VALUES
        ('ip1', '${TENANT_A}', 'doc_paid', 2000000, 'paystack', 'ref-1', 'USD', now());
    `)
  );

  it("ANSWERS ABOUT INVOICES, not about people", async () => {
    const text = await ask("What invoices are outstanding?");
    expect(text, text).toMatch(/INV-1002/);
    expect(text).toMatch(/15,000/);
  });

  it("leaves out an invoice that has been paid in full", async () => {
    expect(await ask("Who owes me money?")).not.toMatch(/INV-1001/);
  });

  it("says plainly when nothing is owed", async () => {
    await db.seed(`DELETE FROM documents;`);
    expect(await ask("Who owes me money?")).toMatch(/Nothing outstanding/i);
  });
});

describe("where a question goes", () => {
  const routes: [string, string][] = [
    ["What invoices are outstanding?", "invoices"],
    ["Who owes me money?", "invoices"],
    ["What is my average deal size?", "performance"],
    ["Who should I follow up with?", "followups"],
    ["What's my pipeline worth?", "pipeline"],
  ];

  for (const [question, intent] of routes) {
    it(`"${question}" is read as ${intent}`, () => {
      const ranked = rankIntents(question, INTENTS);
      expect(ranked[0]?.id, `read as ${ranked[0]?.id} instead`).toBe(intent);
      /* And confidently, or it falls through to the suggestions instead. */
      expect(ranked[0]!.score).toBeGreaterThanOrEqual(CONFIDENT);
    });
  }

  it("never leaves two readings tied at the top, where sort order decides the answer", () => {
    for (const [question] of routes) {
      const ranked = rankIntents(question, INTENTS);
      if (ranked.length > 1) {
        expect(ranked[0]!.score, `"${question}" ties`).toBeGreaterThan(ranked[1]!.score);
      }
    }
  });
});

describe("meetings the assistant calls upcoming", () => {
  beforeEach(() =>
    db.seed(`
      DELETE FROM meetings;
      INSERT INTO meetings (id, sub_account_id, contact_id, topic, scheduled_at, duration_min, outcome) VALUES
        ('m_past', '${TENANT_A}', 'c_open', 'Follow-up call', now() - interval '2 days', 30, 'scheduled'),
        ('m_soon', '${TENANT_A}', 'c_open', 'Site visit',     now() + interval '1 day',  30, 'scheduled'),
        ('m_late', '${TENANT_A}', 'c_open', 'Design review',  now() + interval '3 days', 30, 'scheduled');
    `)
  );

  it("DOES NOT OFFER A MEETING THAT HAS ALREADY HAPPENED as coming up", async () => {
    const text = await ask("What's on today?");
    expect(text, text).not.toMatch(/Follow-up call/);
    expect(text).toMatch(/Site visit/);
  });

  it("puts them in the order they will happen", async () => {
    const text = await ask("What's on today?");
    expect(text.indexOf("Site visit")).toBeLessThan(text.indexOf("Design review"));
  });

  it("names the day, so two meetings are not both just a time", async () => {
    expect(await ask("What's on today?")).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("a question about a period", () => {
  it("SAYS THE FIGURES ARE ALL-TIME rather than ignoring the year in silence", async () => {
    const text = await ask("How much have I won this year?");
    expect(text, text).toMatch(/all-time/i);
  });

  it("says nothing of the sort when no period was asked for", async () => {
    expect(await ask("How many deals do I have?")).not.toMatch(/all-time/i);
  });
});
