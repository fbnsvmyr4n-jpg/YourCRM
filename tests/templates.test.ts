import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B } from "./helpers/pg";
import { checkTemplate, fieldsIn, renderTemplate, smsSegments, valuesFor } from "../src/server/template-rules";

/** Message templates: filling them in, checking them, and who may change them. */

describe("filling a template in", () => {
  const values = valuesFor({ name: "Amara Dube", company: "Dube Landscaping" }, { name: "Thabo Mokoena", business: "Acme Cranes" });

  it("replaces every field, however it is spaced or capitalised", () => {
    expect(renderTemplate("Hi {{first_name}}, {{ MY_NAME }} from {{business_name}} here.", values)).toEqual({
      text: "Hi Amara, Thabo Mokoena from Acme Cranes here.",
      missing: [],
    });
  });

  it("A FIELD WITH NO VALUE BECOMES NOTHING — never braces in a client's inbox — and is reported", () => {
    const noCompany = valuesFor({ name: "Ben", company: "" }, { name: "Thabo", business: "Acme" });
    expect(renderTemplate("Hi {{first_name}} at {{company}}, {{company}}", noCompany)).toEqual({
      text: "Hi Ben at , ",
      missing: ["company"],
    });
  });

  it("a field this product does not know is dropped, not sent as braces", () => {
    expect(renderTemplate("Hi {{nickname}}!", values)).toEqual({ text: "Hi !", missing: [] });
  });

  it("lists the fields a text uses, once each", () => {
    expect(fieldsIn("{{first_name}} {{ First_Name }} {{company}}")).toEqual(["first_name", "company"]);
  });
});

describe("checking a template", () => {
  const base = { name: " Quote follow-up ", channel: "email", subject: "Your quote, {{first_name}}", body: "Hi {{first_name}}" };

  it("keeps a good one, tidied", () => {
    expect(checkTemplate(base)).toEqual({ name: "Quote follow-up", channel: "email", subject: "Your quote, {{first_name}}", body: "Hi {{first_name}}" });
  });

  it("REFUSES A MISSPELT FIELD, naming it", () => {
    expect(checkTemplate({ ...base, body: "Hi {{frist_name}} and {{compnay}}" })).toEqual({
      error: "{{frist_name}}, {{compnay}} are not fields. Use one of the fields listed under the message.",
    });
  });

  it("drops the subject on a channel that has none", () => {
    expect(checkTemplate({ ...base, channel: "sms" })).toMatchObject({ channel: "sms", subject: "" });
  });

  it.each([
    [{ name: "" }, "Give the template a name."],
    [{ channel: "fax" }, "Choose email, WhatsApp or SMS."],
    [{ body: "   " }, "Write the message."],
  ])("refuses %j", (over, error) => {
    expect(checkTemplate({ ...base, ...over })).toEqual({ error });
  });
});

describe("what an SMS costs", () => {
  it.each([
    ["", 0, "GSM-7"],
    ["a".repeat(160), 1, "GSM-7"],
    ["a".repeat(161), 2, "GSM-7"],
    ["a".repeat(306), 2, "GSM-7"],
    ["a".repeat(307), 3, "GSM-7"],
    ["€".repeat(80), 1, "GSM-7"],
    ["€".repeat(81), 2, "GSM-7"],
    ["a".repeat(69) + "😀", 2, "UCS-2"],
    ["ş".repeat(70), 1, "UCS-2"],
    ["ş".repeat(71), 2, "UCS-2"],
  ])("%j… is %d segment(s) in %s", (text, segments, encoding) => {
    expect(smsSegments(text)).toMatchObject({ segments, encoding });
  });
});

/* ------------------------------------------------------------------ */

const as = globalThis as { __tplRole?: string; __tplUser?: string };

vi.mock("@/server/tenant-session", () => {
  const run = async <T,>(fn: (q: unknown) => Promise<T>) => {
    const pg = await import("./helpers/pg");
    const { withTenant } = await import("../src/server/tenant");
    const g = globalThis as { __tplRole?: string; __tplUser?: string };
    return withTenant(
      { agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: g.__tplUser ?? pg.USER_A, role: (g.__tplRole ?? "owner") as "owner" },
      (q) => fn(q)
    );
  };
  return { withCurrentTenant: run };
});
vi.mock("@/server/revalidate", () => ({ revalidateApp: () => {} }));

let db: TestDb;
let actions: typeof import("../src/app/(app)/settings/template-actions");
let withSystem: typeof import("../src/server/tenant").withSystem;
let closePool: typeof import("../src/server/db").closePool;
const read = <T,>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};

describe("templates through Settings", () => {
  beforeAll(async () => {
    db = await startTestDb();
    ({ withSystem } = await import("../src/server/tenant"));
    ({ closePool } = await import("../src/server/db"));
    actions = await import("../src/app/(app)/settings/template-actions");
  });
  afterAll(async () => {
    await closePool?.();
    await db.stop();
  });
  beforeEach(async () => {
    as.__tplRole = "owner";
    as.__tplUser = undefined;
    await db.seed(`
      DELETE FROM message_templates;
      DELETE FROM users WHERE id = 'u_someone_else';
      INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role)
        VALUES ('u_someone_else', 'ag_test', '${TENANT_A}', 'else@test.local', 'x', 'Someone', 'member');
      INSERT INTO message_templates (id, sub_account_id, name, channel, body, created_by_user_id) VALUES
        ('mt_owner', '${TENANT_A}', 'Owner''s note', 'whatsapp', 'Hi {{first_name}}', 'u_test_a'),
        ('mt_theirs', '${TENANT_B}', 'Theirs', 'sms', 'x', NULL);
    `);
  });

  it("saves one, and refuses a second with the same name in any case", async () => {
    expect(await actions.createTemplateAction(undefined, form({ name: "Reminder", channel: "sms", body: "Hi {{first_name}}" }))).toEqual({
      ok: "Saved “Reminder”. It is in the Template menu when you write.",
    });
    expect(await actions.createTemplateAction(undefined, form({ name: "REMINDER", channel: "email", body: "x" }))).toEqual({
      error: "There is already a template called “REMINDER”.",
    });
  });

  it("A MEMBER MAY WRITE ONE, BUT NOT CHANGE A COLLEAGUE'S", async () => {
    as.__tplRole = "member";
    as.__tplUser = "u_someone_else";
    expect((await actions.createTemplateAction(undefined, form({ name: "Mine", channel: "sms", body: "x" })))?.ok).toBeTruthy();
    expect(await actions.updateTemplateAction(undefined, form({ id: "mt_owner", name: "Changed", channel: "whatsapp", body: "y" }))).toEqual({
      error: "Only whoever wrote this template, or somebody who manages the team, can change it.",
    });
    expect(await actions.deleteTemplateAction(undefined, form({ id: "mt_owner" }))).toEqual({
      error: "Only whoever wrote this template, or somebody who manages the team, can change it.",
    });
    expect(await read(`SELECT name FROM message_templates WHERE id = 'mt_owner'`)).toEqual([{ name: "Owner's note" }]);
  });

  it("the author changes and deletes their own; another workspace's is not there", async () => {
    expect(await actions.updateTemplateAction(undefined, form({ id: "mt_owner", name: "Owner's note", channel: "whatsapp", body: "Hello {{first_name}}" }))).toEqual({ ok: "Saved." });
    expect(await actions.deleteTemplateAction(undefined, form({ id: "mt_theirs" }))).toEqual({ error: "That template no longer exists." });
    expect(await actions.deleteTemplateAction(undefined, form({ id: "mt_owner" }))).toEqual({ ok: "Deleted." });
    expect(await read(`SELECT id FROM message_templates`)).toEqual([{ id: "mt_theirs" }]);
  });

  it("the database refuses a subject on a WhatsApp template", async () => {
    await expect(
      db.seed(`INSERT INTO message_templates (id, sub_account_id, name, channel, subject, body) VALUES ('mt_x', '${TENANT_A}', 'x', 'whatsapp', 'Subject', 'b')`)
    ).rejects.toThrow(/subject_shape/);
  });
});
