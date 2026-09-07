import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The tool loop itself.
 *
 * `tests/quotes.test.ts` drives the tools directly, which proves what they
 * write. It says nothing about the loop that gets a model's `tool_use` block to
 * them and its result back — and that loop is where the interesting mistakes
 * live: an assistant turn rebuilt from its text (dropping the thinking blocks
 * the model needs to continue its own reasoning), tool results split across
 * several user messages (which teaches the model to stop asking for more than
 * one thing at a time), or usage read off the last response so that the
 * messages which cost the most are the ones under-reported.
 *
 * The model is stubbed, deliberately and only here: what is under test is our
 * half of the conversation. Whether Claude CHOOSES to call the tool is a
 * different question and needs a real key — this proves that when it does, the
 * right thing happens.
 */

const created: Array<Record<string, unknown>> = [];
/** What the stub returns, in order. Set per test. */
let scripted: Array<Record<string, unknown>> = [];

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async (params: Record<string, unknown>) => {
        /* Deep-copied, because the loop MUTATES the messages array it passes —
           holding the reference would make every recorded call look like the
           last one, and the assertion about what the model was sent would
           silently pass on anything. */
        created.push(structuredClone(params));
        const next = scripted.shift();
        if (!next) throw new Error("the stub ran out of scripted responses");
        return next;
      },
    };
  }
  return { default: FakeAnthropic };
});

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
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx, fn);

const JOB = "d_stellenbosch";
const CRANE = 1_200_000;

/** An assistant turn that asks for a quotation, thinking block and all. */
const wantsQuote = (lines: unknown) => ({
  content: [
    { type: "thinking", thinking: "", signature: "sig-abc" },
    { type: "text", text: "One moment — pricing that up." },
    {
      type: "tool_use",
      id: "toolu_01",
      name: "draft_quotation",
      input: { project: "Rebuild warehouse", lines },
    },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 1000, output_tokens: 200 },
});

const finishes = (text: string) => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1500, output_tokens: 60 },
});

beforeAll(async () => {
  db = await startTestDb();
  /* The live branch is gated on this variable, so the loop only runs with one
     set. It is a stub's name, not a credential. */
  process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-one";
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  ({ answer } = await import("../src/server/chat-agent"));
});

afterAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  created.length = 0;
  scripted = [];
  await db.seed(`
    DELETE FROM document_lines; DELETE FROM documents;
    DELETE FROM price_items; DELETE FROM usage_events;
    DELETE FROM deals; DELETE FROM contacts; DELETE FROM companies;

    INSERT INTO companies (id, sub_account_id, name) VALUES
      ('co_heineken', '${TENANT_A}', 'Heineken');

    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, company_id) VALUES
      ('ct_procure', '${TENANT_A}', 'Amara', 'Dube', 'amara@heineken.test', 'co_heineken');

    INSERT INTO deals (id, sub_account_id, company_id, contact_id, title, value_cents, stage)
    VALUES ('${JOB}', '${TENANT_A}', 'co_heineken', 'ct_procure',
            'Rebuild warehouse', 1800000_00, 'discovery');

    INSERT INTO price_items (id, sub_account_id, name, unit, unit_cents) VALUES
      ('pi_crane', '${TENANT_A}', 'Mobile crane hire', 'per day', ${CRANE});`);
});

describe("the model asks for a quotation and gets one", () => {
  it("runs the tool, feeds the result back, and answers", async () => {
    scripted = [
      wantsQuote([{ item: "Mobile crane hire", quantity: 3.5 }]),
      finishes("Drafted Q-1001 for Heineken — $42,000. It's waiting for your approval."),
    ];

    const result = await inA((q) =>
      answer(q, "Quote Heineken for three and a half days of crane", [], "Bradley")
    );

    expect(result.live).toBe(true);
    // Both turns' text, in order — the "one moment" is part of what was said.
    expect(result.text).toContain("One moment");
    expect(result.text).toContain("Drafted Q-1001");
    expect(created).toHaveLength(2);

    const row = await inA((q) =>
      q.one<{ number: string; status: string; total: string }>(
        `SELECT d.number, d.status,
                (SELECT ROUND(SUM(l.quantity * l.unit_cents))::bigint::text
                   FROM document_lines l WHERE l.document_id = d.id) AS total
           FROM documents d WHERE d.sub_account_id = $1`,
        [TENANT_A]
      )
    );
    expect(row?.status).toBe("awaiting_approval");
    expect(row?.total).toBe("4200000");
  });

  it("sends the assistant turn back unchanged, thinking block and all", async () => {
    scripted = [
      wantsQuote([{ item: "Mobile crane hire", quantity: 1 }]),
      finishes("Done."),
    ];
    await inA((q) => answer(q, "Quote it", [], "Bradley"));

    const second = created[1].messages as Array<{ role: string; content: unknown }>;
    const assistant = second.find((m) => m.role === "assistant");
    const blocks = assistant?.content as Array<{ type: string; signature?: string }>;

    /* Rebuilt from the text this would be one block and no signature — and a
       model asked to continue from a turn it did not produce has lost its own
       reasoning halfway through pricing a job. */
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(blocks[0].signature).toBe("sig-abc");
  });

  it("returns every tool result in ONE user message", async () => {
    /*
       TWO tool calls in one turn, and that is the whole point of the fixture.

       With a single call this test could not see the property it claims: split
       one result across "several" messages and you still have one message, so
       the mutation that pushes each result separately passed a green test.
       Caught by mutating the loop deliberately — an assertion that cannot fail
       is worse than no assertion, because it reads like cover.

       Splitting them is not a cosmetic difference: it teaches the model to stop
       asking for more than one thing at a time.
    */
    scripted = [
      {
        content: [
          { type: "text", text: "Pricing both up." },
          {
            type: "tool_use",
            id: "toolu_01",
            name: "draft_quotation",
            input: { project: "Rebuild warehouse", lines: [{ item: "Mobile crane hire", quantity: 1 }] },
          },
          {
            type: "tool_use",
            id: "toolu_02",
            name: "draft_quotation",
            input: { project: "Rebuild warehouse", lines: [{ item: "Mobile crane hire", quantity: 2 }] },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 1000, output_tokens: 200 },
      },
      finishes("Both drafted."),
    ];
    await inA((q) => answer(q, "Quote both options", [], "Bradley"));

    const second = created[1].messages as Array<{ role: string; content: unknown }>;
    const results = second.filter(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some((b) => b.type === "tool_result")
    );
    expect(results).toHaveLength(1);

    const blocks = results[0].content as Array<{ type: string; tool_use_id: string; content: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["toolu_01", "toolu_02"]);
    expect(blocks[0].content).toMatch(/Drafted quotation Q-1001/);
    // The second gets its own number rather than colliding with the first.
    expect(blocks[1].content).toMatch(/Drafted quotation Q-1002/);
  });

  it("bills every call in the exchange, not only the last", async () => {
    scripted = [
      wantsQuote([{ item: "Mobile crane hire", quantity: 1 }]),
      finishes("Done."),
    ];
    await inA((q) => answer(q, "Quote it", [], "Bradley"));

    const usage = await inA((q) =>
      q.one<{ detail: { inputTokens: number; outputTokens: number }; cost_micros: string }>(
        `SELECT detail, cost_micros::text FROM usage_events WHERE sub_account_id = $1`,
        [TENANT_A]
      )
    );
    // 1000 + 1500 in, 200 + 60 out. Reading the last response alone would
    // under-report the messages that cost the most — the ones that used tools.
    expect(usage?.detail.inputTokens).toBe(2500);
    expect(usage?.detail.outputTokens).toBe(260);
    expect(Number(usage?.cost_micros)).toBeGreaterThan(0);
  });

  it("hands a refusal back to the model rather than writing a guess", async () => {
    scripted = [
      wantsQuote([{ item: "Helicopter lift", quantity: 1 }]),
      finishes("A helicopter lift isn't on your price list. I can quote the crane instead."),
    ];
    const result = await inA((q) => answer(q, "Quote a helicopter lift", [], "Bradley"));

    const second = created[1].messages as Array<{ role: string; content: unknown }>;
    const toolResult = (second.at(-1)!.content as Array<{ content: string }>)[0].content;
    expect(toolResult).toMatch(/Nothing matches "Helicopter lift"/);
    expect(toolResult).toMatch(/Mobile crane hire/);

    expect(result.text).toContain("isn't on your price list");
    const count = await inA((q) =>
      q.one<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE sub_account_id = $1`, [
        TENANT_A,
      ])
    );
    expect(count?.n).toBe(0);
  });

  it("tells the model the house rules, and the price list, before it can quote", async () => {
    scripted = [finishes("Your pipeline is looking healthy.")];
    await inA((q) => answer(q, "How's my pipeline?", [], "Bradley"));

    const system = created[0].system as string;
    expect(system).toMatch(/You CANNOT send a quotation/);
    expect(system).toMatch(/Mobile crane hire — \$12000\.00 per day/);

    /*
       And the tools are on every call, so the capability does not depend on
       the question having sounded like a quotation.

       Written as the WHOLE list rather than a contains-check, deliberately: a
       tool reaching the model is a capability somebody granted it, and this
       failing when one is added is the point. `start_project` was added here
       on purpose — quoting requires a project, and before it the agent could
       only refuse and send somebody to another screen.
    */
    const tools = created[0].tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "draft_quotation",
      "revise_quotation",
      "start_project",
    ]);

    /* And it is told when NOT to reach for it. A second project for the same
       job splits its documents, its schedule and its margin in two. */
    expect(system).toMatch(/a second project for the same job splits/i);
  });

  it("gives up after four passes rather than talking to itself", async () => {
    // A model that keeps calling tools forever is a paid loop with a chat box
    // waiting on it. Whatever text it produced is what the user gets.
    scripted = Array.from({ length: 6 }, () =>
      wantsQuote([{ item: "Mobile crane hire", quantity: 1 }])
    );
    const result = await inA((q) => answer(q, "Quote it", [], "Bradley"));

    expect(created).toHaveLength(4);
    expect(result.text).toContain("One moment");
  });
});

describe("when the model cannot be reached", () => {
  it("falls back to the deterministic assistant instead of an error page", async () => {
    scripted = [];
    const result = await inA((q) => answer(q, "What's my pipeline worth?", [], "Bradley"));

    expect(result.live).toBe(false);
    expect(result.text).toMatch(/couldn't reach the AI service/i);
    // And still answers from real data rather than apologising and stopping.
    expect(result.text).toMatch(/pipeline/i);
  });
});
