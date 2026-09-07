import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The CRM Tool Gateway, proven without a telephone.
 *
 * The specification is explicit that this layer is built and tested before any
 * voice touches it, and the reason is that everything dangerous about a voice
 * agent lives here rather than in the audio: an agent that can be talked into a
 * mutation it should not make, or that books the same meeting twice because a
 * webhook was redelivered, is not a voice problem.
 *
 * So these tests are adversarial by design. They are what happens when the
 * model asks for something it may not have, sends arguments that do not match
 * its own schema, retries a write, or names a record belonging to somebody
 * else's workspace.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let gateway: typeof import("../src/server/agent/gateway");
let tools: typeof import("../src/server/agent/tools");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string, role = "owner"): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: role as TenantContext["role"],
});
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);

/** Everything switched on, which is the permissive case worth attacking. */
const FULL = new Set([
  "read_crm",
  "write_activity",
  "write_contact",
  "write_task",
  "write_meeting",
  "draft_quote",
  "call_control",
] as const);

const principal = (over: Partial<import("../src/server/agent/gateway").AgentPrincipal> = {}) => ({
  agent: "voice" as const,
  userId: USER_A,
  role: "owner",
  callId: "CA-test-1",
  capabilities: FULL as ReadonlySet<import("../src/server/agent/gateway").ToolCapability>,
  ...over,
});

const run = (call: Parameters<typeof gateway.invoke>[3], who = principal()) =>
  inA((q) => gateway.invoke(q, tools.CRM_TOOL_REGISTRY, who, call));

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  gateway = await import("../src/server/agent/gateway");
  tools = await import("../src/server/agent/tools");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM agent_tool_executions; DELETE FROM activities;
    DELETE FROM deals; DELETE FROM contacts; DELETE FROM companies;

    INSERT INTO companies (id, sub_account_id, name) VALUES
      ('co_heineken', '${TENANT_A}', 'Heineken');

    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, phone, company_id) VALUES
      ('ct_amara', '${TENANT_A}', 'Amara', 'Dube', 'amara@heineken.test', '021 555 0142', 'co_heineken'),
      ('ct_ben',   '${TENANT_A}', 'Ben',   'Cole',  NULL,                 '+27 21 555 0199', NULL),
      ('ct_theirs','${TENANT_B}', 'Rival', 'Person', NULL,                '021 555 0142',    NULL);`)
);

describe("who the agent is allowed to be", () => {
  it("refuses a tool the agent has not been granted", async () => {
    const out = await run(
      { tool: "add_contact_note", input: { contactId: "ct_amara", note: "hello" } },
      principal({ capabilities: new Set(["read_crm"]) })
    );
    expect(out.status).toBe("refused");
    if (out.status === "refused") expect(out.error).toMatch(/not allowed to write activity/i);
  });

  it("refuses every tool to a role that cannot see customer records", async () => {
    /* IT and accounts do not read customer data, and an agent borrowing their
       account does not get to either. */
    const out = await run(
      { tool: "identify_caller", input: { phone: "021 555 0142" } },
      principal({ role: "finance" })
    );
    expect(out.status).toBe("refused");
    if (out.status === "refused") expect(out.error).toMatch(/does not have access/i);
  });

  it("refuses a tool that does not exist rather than throwing", async () => {
    const out = await run({ tool: "update_anything", input: { table: "deals" } });
    expect(out.status).toBe("refused");
    if (out.status === "refused") expect(out.error).toMatch(/no tool called/i);
  });

  it("records a refusal in the audit trail", async () => {
    await run(
      { tool: "add_contact_note", input: { contactId: "ct_amara", note: "x" } },
      principal({ capabilities: new Set(["read_crm"]) })
    );
    const row = await inA((q) =>
      q.one<{ status: string; tool_name: string; actor_user_id: string }>(
        `SELECT status, tool_name, actor_user_id FROM agent_tool_executions WHERE sub_account_id = $1`,
        [TENANT_A]
      )
    );
    expect(row?.status).toBe("refused");
    expect(row?.tool_name).toBe("add_contact_note");
    /* An agent is never its own authority: the trail names a person. */
    expect(row?.actor_user_id).toBe(USER_A);
  });
});

describe("what the agent is allowed to send", () => {
  it("refuses arguments that do not survive our own parsing", async () => {
    /* The schema is a hint to the model. This is the guarantee. */
    const out = await run({ tool: "identify_caller", input: { phone: "12" } });
    expect(out.status).toBe("refused");
    if (out.status === "refused") expect(out.error).toMatch(/not enough of a phone number/i);
  });

  it("refuses a note with no contact", async () => {
    const out = await run({ tool: "add_contact_note", input: { note: "something" } });
    expect(out.status).toBe("refused");
  });

  it("refuses an email address it cannot read back", async () => {
    /* A wrong address on a record is worse than none: somebody will send a
       quotation to it. */
    const out = await run({
      tool: "create_contact",
      input: { firstName: "Sam", phone: "021 555 0111", email: "not an address" },
      confirmed: true,
    });
    expect(out.status).toBe("refused");
    if (out.status === "refused") expect(out.error).toMatch(/could not be read back/i);
  });
});

describe("identifying a caller", () => {
  it("matches a number written differently from the way it was stored", async () => {
    const out = await run({ tool: "identify_caller", input: { phone: "+27215550142" } });
    expect(out.status).toBe("succeeded");
    if (out.status === "succeeded") {
      const v = out.value as { known: boolean; name?: string };
      expect(v.known).toBe(true);
      expect(v.name).toBe("Amara Dube");
    }
  });

  it("says it does not know an unrecognised number", async () => {
    const out = await run({ tool: "identify_caller", input: { phone: "021 555 9999" } });
    expect(out.status).toBe("succeeded");
    if (out.status === "succeeded") {
      expect((out.value as { known: boolean; reason: string }).reason).toBe("no_match");
    }
  });

  it("never reaches into another workspace, even on an identical number", async () => {
    /* Tenant B has a contact on the same number. Finding them would be a
       cross-customer disclosure to whoever dialled. */
    const out = await run({ tool: "identify_caller", input: { phone: "021 555 0142" } });
    expect(out.status).toBe("succeeded");
    if (out.status === "succeeded") {
      expect((out.value as { name?: string }).name).toBe("Amara Dube");
    }
  });

  it("asks rather than choosing when two people share a number", async () => {
    await db.seed(`INSERT INTO contacts (id, sub_account_id, first_name, last_name, phone)
                   VALUES ('ct_dupe', '${TENANT_A}', 'Sipho', 'Ndlovu', '021 555 0142')`);
    const out = await run({ tool: "identify_caller", input: { phone: "021 555 0142" } });
    expect(out.status).toBe("succeeded");
    if (out.status === "succeeded") {
      const v = out.value as { known: boolean; reason: string; candidates: { name: string }[] };
      expect(v.known).toBe(false);
      expect(v.reason).toBe("ambiguous");
      expect(v.candidates.map((c) => c.name).sort()).toEqual(["Amara Dube", "Sipho Ndlovu"]);
    }
  });

  it("hands back only what is needed to greet somebody", async () => {
    /* A caller is an outsider. Their email and their deal values are not part
       of saying hello, and would be a disclosure if the phone were stolen. */
    const out = await run({ tool: "identify_caller", input: { phone: "021 555 0142" } });
    if (out.status !== "succeeded") throw new Error("expected success");
    expect(Object.keys(out.value as object).sort()).toEqual(
      ["company", "contactId", "isClient", "known", "name"]
    );
  });
});

describe("nothing happens twice", () => {
  it("replays the first result instead of writing a second note", async () => {
    const call = {
      tool: "add_contact_note",
      input: { contactId: "ct_amara", note: "Wants the crane for three days." },
      actionId: "toolu_01",
    };
    const first = await run(call);
    const second = await run(call);

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    if (first.status === "succeeded" && second.status === "succeeded") {
      expect(second.replayed).toBe(true);
      expect(second.value).toEqual(first.value);
    }

    const notes = await inA((q) =>
      q.rows<{ id: string }>(
        `SELECT id FROM activities WHERE sub_account_id = $1 AND kind = 'note'`,
        [TENANT_A]
      )
    );
    expect(notes).toHaveLength(1);
  });

  it("treats a genuinely different note as different work", async () => {
    await run({ tool: "add_contact_note", input: { contactId: "ct_amara", note: "First thing." } });
    await run({ tool: "add_contact_note", input: { contactId: "ct_amara", note: "Second thing." } });
    const notes = await inA((q) =>
      q.rows<{ id: string }>(`SELECT id FROM activities WHERE sub_account_id = $1`, [TENANT_A])
    );
    expect(notes).toHaveLength(2);
  });

  it("does not create the same person twice when a call is retried", async () => {
    const call = {
      tool: "create_contact",
      input: { firstName: "Nomsa", lastName: "Khumalo", phone: "021 555 0177" },
      confirmed: true,
      actionId: "toolu_new_person",
    };
    await run(call);
    await run(call);
    const rows = await inA((q) =>
      q.rows<{ id: string }>(
        `SELECT id FROM contacts WHERE sub_account_id = $1 AND first_name = 'Nomsa'`,
        [TENANT_A]
      )
    );
    expect(rows).toHaveLength(1);
  });

  it("does not create a second record for somebody already on that number", async () => {
    /* Belt and braces beside idempotency: a colleague may have typed them in
       between identifying and creating. */
    const out = await run({
      tool: "create_contact",
      input: { firstName: "Amara", lastName: "Dube", phone: "021 555 0142" },
      confirmed: true,
    });
    expect(out.status).toBe("succeeded");
    if (out.status === "succeeded") {
      expect((out.value as { contactId: string }).contactId).toBe("ct_amara");
    }
  });
});

describe("some things need somebody to say yes", () => {
  it("refuses to create a contact the caller has not agreed to", async () => {
    const out = await run({
      tool: "create_contact",
      input: { firstName: "Sam", phone: "021 555 0123" },
    });
    expect(out.status).toBe("refused");
    if (out.status === "refused") expect(out.error).toMatch(/confirm/i);
  });

  it("goes ahead once the caller has agreed", async () => {
    const out = await run({
      tool: "create_contact",
      input: { firstName: "Sam", lastName: "Cele", phone: "021 555 0123" },
      confirmed: true,
    });
    expect(out.status).toBe("succeeded");
  });
});

describe("what the model is offered", () => {
  it("hides tools the agent has no capability for", () => {
    const offered = gateway.toolsFor(
      tools.CRM_TOOL_REGISTRY,
      principal({ capabilities: new Set(["read_crm"]) })
    );
    const names = offered.map((t) => t.name);
    expect(names).toContain("identify_caller");
    expect(names).not.toContain("add_contact_note");
    expect(names).not.toContain("create_contact");
  });

  it("tells the model when a tool needs the caller's agreement", () => {
    const offered = gateway.toolsFor(tools.CRM_TOOL_REGISTRY, principal());
    const create = offered.find((t) => t.name === "create_contact");
    expect(create?.description).toMatch(/agreed to it out loud/i);
  });

  it("refuses to build a registry with two tools of one name", () => {
    const one = tools.CRM_TOOLS[0];
    expect(() => gateway.buildRegistry([one, one])).toThrow(/Two tools are called/);
  });
});

describe("phone normalisation", () => {
  it("compares on the part of a number that does not change", () => {
    expect(tools.phoneTail("021 555 0142")).toBe(tools.phoneTail("+27 21 555 0142"));
    expect(tools.phoneTail("(021) 555-0142")).toBe(tools.phoneTail("0215550142"));
  });

  it("keeps different numbers different", () => {
    expect(tools.phoneTail("021 555 0142")).not.toBe(tools.phoneTail("021 555 0143"));
  });
});
