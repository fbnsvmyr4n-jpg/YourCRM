import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * Claude answering the phone.
 *
 * The model is stubbed, as it is for the chat loop, because what is under test
 * is our half: that a tool the model asks for goes through the gateway rather
 * than around it, that a refusal is reported to the model as a refusal instead
 * of being dressed up, and that the call survives everything the model can do
 * wrong.
 *
 * That last one is the reason this file exists. A caller is on the line. The
 * failure mode that matters is not a wrong answer, it is silence.
 */

const created: Array<Record<string, unknown>> = [];
let scripted: Array<Record<string, unknown> | Error> = [];

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async (params: Record<string, unknown>) => {
        created.push(structuredClone(params));
        const next = scripted.shift();
        if (!next) throw new Error("the stub ran out of scripted responses");
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }
  return { default: FakeAnthropic };
});

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let brain: typeof import("../src/server/agent/voice-brain");
let principalFor: typeof import("../src/server/agent/principal").voicePrincipal;
let closePool: typeof import("../src/server/db").closePool;

const ctx: TenantContext = {
  agencyId: AGENCY,
  subAccountId: TENANT_A,
  userId: USER_A,
  role: "owner",
};
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx, fn);

const session = () => ({
  id: "CA-brain-1",
  from: "+27215550142",
  step: "intent" as const,
  transcript: [{ speaker: "Agent" as const, text: "Thanks for calling." }],
  startedAt: new Date().toISOString(),
});

const says = (text: string) => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 300, output_tokens: 40 },
});

const wantsTool = (name: string, input: unknown, id = "toolu_v1") => ({
  content: [{ type: "tool_use", id, name, input }],
  stop_reason: "tool_use",
  usage: { input_tokens: 300, output_tokens: 60 },
});

/** Runs a turn as the voice agent would, principal and all. */
const turn = async (heard: string) => {
  const principal = await principalFor(ctx, "CA-brain-1");
  if (!principal) throw new Error("no principal");
  return inA((q) => brain.speak(q, principal, session(), heard));
};

beforeAll(async () => {
  db = await startTestDb();
  process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-one";
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  brain = await import("../src/server/agent/voice-brain");
  ({ voicePrincipal: principalFor } = await import("../src/server/agent/principal"));
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
    DELETE FROM agent_tool_executions; DELETE FROM activities; DELETE FROM usage_events;
    DELETE FROM meetings; DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, phone)
    VALUES ('ct_amara', '${TENANT_A}', 'Amara', 'Dube', '021 555 0142');`);
});

describe("whose authority the agent borrows", () => {
  it("acts as a real person, never as itself", async () => {
    const principal = await principalFor(ctx, "CA-1");
    expect(principal?.userId).toBe(USER_A);
    expect(principal?.agent).toBe("voice");
  });

  it("is granted less than the person whose account it borrows", async () => {
    const principal = await principalFor(ctx, "CA-1");
    /* No task or call-control capability, and the gateway refuses anything
       outside the set — so this list is the whole answer to "what can somebody
       achieve by phoning the number". */
    expect([...(principal?.capabilities ?? [])].sort()).toEqual([
      "draft_quote",
      "read_crm",
      "write_activity",
      "write_contact",
      "write_meeting",
    ]);
  });

  it("refuses to run at all when nobody in the workspace may see the records", async () => {
    /* A workspace of IT and accounts has no member whose authority a
       customer-facing agent could honestly borrow. */
    await db.seed(`UPDATE users SET role = 'finance' WHERE agency_id = '${AGENCY}'`);
    expect(await principalFor(ctx, "CA-1")).toBeNull();
    await db.seed(`UPDATE users SET role = 'owner' WHERE id = '${USER_A}'`);
  });
});

describe("a turn that uses a tool", () => {
  it("goes through the gateway, and the write actually happens", async () => {
    scripted = [
      wantsTool("identify_caller", { phone: "+27215550142" }),
      says("Hello Amara, good to hear from you. What can I do?"),
    ];
    const reply = await turn("hi it's Amara");

    expect(reply?.say).toMatch(/Hello Amara/);
    /* Through the gateway means audited. */
    const row = await inA((q) =>
      q.one<{ tool_name: string; status: string; actor_user_id: string }>(
        `SELECT tool_name, status, actor_user_id FROM agent_tool_executions WHERE sub_account_id = $1`,
        [TENANT_A]
      )
    );
    expect(row?.tool_name).toBe("identify_caller");
    expect(row?.status).toBe("succeeded");
    expect(row?.actor_user_id).toBe(USER_A);
  });

  it("uses the model's own tool id as the idempotency key", async () => {
    /* Twilio redelivering a turn must not write the note twice, and the
       model's id is stable across that redelivery. */
    scripted = [
      wantsTool("add_contact_note", { contactId: "ct_amara", note: "Wants a crane." }, "toolu_same"),
      says("Noted."),
      wantsTool("add_contact_note", { contactId: "ct_amara", note: "Wants a crane." }, "toolu_same"),
      says("Noted."),
    ];
    await turn("we need a crane");
    await turn("we need a crane");

    const notes = await inA((q) =>
      q.rows<{ id: string }>(`SELECT id FROM activities WHERE sub_account_id = $1`, [TENANT_A])
    );
    expect(notes).toHaveLength(1);
  });

  it("keeps two identical instructions apart, because the tool id differs", async () => {
    /*
       The case that proves the model's own tool id is what keys the write.

       Both notes say the same words, so hashing the ARGUMENTS would produce one
       key and silently swallow the second — a caller repeating an instruction
       and the CRM quietly ignoring it. Different tool ids mean different
       intents, and both are recorded.

       Written after a mutation survived: replacing `actionId: call.id` with
       `undefined` left the earlier duplicate test green, because that one sends
       identical input on purpose and the hash fallback deduplicates it too.
    */
    scripted = [
      wantsTool("add_contact_note", { contactId: "ct_amara", note: "Call me back." }, "toolu_a"),
      says("Noted."),
      wantsTool("add_contact_note", { contactId: "ct_amara", note: "Call me back." }, "toolu_b"),
      says("Noted again."),
    ];
    await turn("call me back");
    await turn("I said call me back");

    const notes = await inA((q) =>
      q.rows<{ id: string }>(`SELECT id FROM activities WHERE sub_account_id = $1`, [TENANT_A])
    );
    expect(notes).toHaveLength(2);
  });

  it("tells the model the truth when the gateway refuses", async () => {
    scripted = [
      /* No `confirmed`, so creating a person is refused by the confirmation
         gate rather than quietly done. */
      wantsTool("create_contact", { firstName: "Sam", phone: "021 555 0999" }),
      says("Before I add you, can I confirm — is that Sam?"),
    ];
    await turn("add me as a new customer");

    const secondCall = created[1] as { messages: { role: string; content: unknown }[] };
    const toolResult = secondCall.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => (b as { type?: string }).type === "tool_result") as
      | { content: string; is_error: boolean }
      | undefined;

    expect(toolResult?.is_error).toBe(true);
    expect(toolResult?.content).toMatch(/did not happen/i);
    expect(toolResult?.content).toMatch(/confirm/i);

    const count = await inA((q) =>
      q.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM contacts WHERE sub_account_id = $1 AND first_name = 'Sam'`,
        [TENANT_A]
      )
    );
    expect(count?.n).toBe(0);
  });

  it("passes the caller's spoken agreement through as confirmation", async () => {
    scripted = [
      wantsTool("create_contact", { firstName: "Sam", lastName: "Cele", phone: "021 555 0999", confirmed: true }),
      says("You're on the system now, Sam."),
    ];
    await turn("yes that's right, Sam Cele");

    const count = await inA((q) =>
      q.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM contacts WHERE sub_account_id = $1 AND first_name = 'Sam'`,
        [TENANT_A]
      )
    );
    expect(count?.n).toBe(1);
  });

  it("never offers the model a tool it would only be refused for", async () => {
    scripted = [says("Hello.")];
    await turn("hello");
    const offered = (created[0].tools as { name: string }[]).map((t) => t.name);
    expect(offered).toContain("identify_caller");
    expect(offered).toContain("create_meeting");
    /* And nothing that could put a price in front of a customer unreviewed. */
    expect(offered.some((n) => /send|email|approve/i.test(n))).toBe(false);
  });
});

describe("the call survives us", () => {
  it("gives up rather than hanging when the model errors", async () => {
    scripted = [new Error("upstream timeout")];
    await expect(turn("hello")).rejects.toThrow();
    /* The route turns that throw into the scripted fallback — proven in
       `voice-route.test.ts`. What matters here is that it does not resolve to
       an empty reply the caller would hear as silence. */
  });

  it("returns null rather than an empty sentence", async () => {
    scripted = [{ content: [], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 0 } }];
    expect(await turn("hello")).toBeNull();
  });

  it("does nothing at all without a key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await turn("hello")).toBeNull();
    process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-one";
  });

  it("stops asking for tools after a few rounds rather than holding the line", async () => {
    scripted = Array.from({ length: 8 }, (_, i) =>
      wantsTool("identify_caller", { phone: "+27215550142" }, `toolu_${i}`)
    );
    await turn("hello");
    /* Four calls: the first plus three tool rounds. A model looping on the
       phone is dead air. */
    expect(created).toHaveLength(4);
  });
});

describe("what the caller hears", () => {
  it("hangs up when the agent says goodbye", async () => {
    scripted = [says("I've got all that. Goodbye.")];
    const reply = await turn("that's everything thanks");
    expect(reply?.done).toBe(true);
  });

  it("keeps listening otherwise", async () => {
    scripted = [says("What day suits you?")];
    const reply = await turn("I'd like to book something");
    expect(reply?.done).toBe(false);
  });

  it("is told out loud that a quote is not sent", async () => {
    scripted = [says("ok")];
    await turn("hello");
    const system = created[0].system as string;
    expect(system).toMatch(/NOT sent/);
    expect(system).toMatch(/never promise it is on its way/i);
    /* And the rule that stops it inventing a fact about the business. */
    expect(system).toMatch(/unless a tool told you it/i);
  });

  it("bills the call's model usage to the workspace", async () => {
    scripted = [says("Hello.")];
    await turn("hi");
    const usage = await inA((q) =>
      q.one<{ kind: string; detail: { surface: string } }>(
        `SELECT kind, detail FROM usage_events WHERE sub_account_id = $1`,
        [TENANT_A]
      )
    );
    expect(usage?.kind).toBe("ai_message");
    expect(usage?.detail.surface).toBe("voice");
  });
});
