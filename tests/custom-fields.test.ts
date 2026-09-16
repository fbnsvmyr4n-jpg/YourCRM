import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * Custom fields on a real Postgres: definitions, values, and what the database
 * itself refuses.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let repo: typeof import("../src/server/repos/custom-fields");
let form: typeof import("../src/server/custom-field-form");
let closePool: typeof import("../src/server/db").closePool;

const ctxA: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctxA, fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/custom-fields");
  form = await import("../src/server/custom-field-form");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM custom_field_values; DELETE FROM custom_fields;
    DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES
      ('ct_a', '${TENANT_A}', 'Amara', 'Dube'),
      ('ct_b', '${TENANT_B}', 'Bruno', 'Beta');
    INSERT INTO deals (id, sub_account_id, title, value_cents, stage) VALUES
      ('d_a', '${TENANT_A}', 'Warehouse', 0, 'prospect');
    INSERT INTO custom_fields (id, sub_account_id, entity, label, kind, options, position) VALUES
      ('cf_cap',   '${TENANT_A}', 'deal',    'Capacity',  'number', '{}', 1),
      ('cf_start', '${TENANT_A}', 'deal',    'Site open', 'date',   '{}', 2),
      ('cf_crane', '${TENANT_A}', 'deal',    'Crane',     'choice', ARRAY['Tower','Mobile'], 3),
      ('cf_ind',   '${TENANT_A}', 'contact', 'Inducted',  'yes_no', '{}', 1),
      ('cf_gate',  '${TENANT_A}', 'contact', 'Gate code', 'text',   '{}', 2),
      ('cf_other', '${TENANT_B}', 'contact', 'Theirs',    'text',   '{}', 1);
  `)
);

const post = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};

describe("defining fields", () => {
  it("adds a field at the end of the list", async () => {
    const out = await inA((q) => repo.createField(q, "cf_new", "deal", { label: "Permit", kind: "text", options: [] }));
    expect("field" in out).toBe(true);
    const labels = (await inA((q) => repo.listFields(q, "deal"))).map((f) => f.label);
    expect(labels).toEqual(["Capacity", "Site open", "Crane", "Permit"]);
  });

  it("REFUSES A SECOND LIVE FIELD WITH THE SAME NAME, ignoring case, and keeps the request usable", async () => {
    const out = await inA(async (q) => {
      const refused = await repo.createField(q, "cf_dup", "deal", { label: "CAPACITY", kind: "text", options: [] });
      // The same transaction still works after the refusal.
      return { refused, fields: await repo.listFields(q, "deal") };
    });
    expect(out.refused).toEqual({ error: "There is already a field called “CAPACITY”." });
    expect(out.fields).toHaveLength(3);
  });

  it("lets the same name be used on the other kind of record", async () => {
    const out = await inA((q) => repo.createField(q, "cf_x", "contact", { label: "Capacity", kind: "text", options: [] }));
    expect("field" in out).toBe(true);
  });

  it("ARCHIVING HIDES A FIELD AND KEEPS WHAT PEOPLE TYPED; restoring brings both back", async () => {
    await inA((q) => repo.saveValues(q, "deal", "d_a", [{ field: { id: "cf_cap", kind: "number" }, value: "50" }]));
    await inA((q) => repo.setFieldArchived(q, "cf_cap", true));
    expect((await inA((q) => repo.listFields(q, "deal"))).map((f) => f.id)).not.toContain("cf_cap");
    expect((await inA((q) => repo.valuesFor(q, "deal", ["d_a"])))["d_a"]).toEqual({ cf_cap: "50" });

    await inA((q) => repo.setFieldArchived(q, "cf_cap", false));
    expect((await inA((q) => repo.listFields(q, "deal"))).map((f) => f.id)).toContain("cf_cap");
  });

  it("frees an archived field's name, and says why a restore then clashes", async () => {
    await inA((q) => repo.setFieldArchived(q, "cf_cap", true));
    expect("field" in (await inA((q) => repo.createField(q, "cf_cap2", "deal", { label: "Capacity", kind: "text", options: [] })))).toBe(true);
    expect(await inA((q) => repo.setFieldArchived(q, "cf_cap", false))).toEqual({
      error: "A live field already uses that name. Rename one of them first.",
    });
  });

  it("renames a field and changes choices, but never its kind", async () => {
    await inA((q) => repo.updateField(q, "cf_crane", { label: "Crane type", options: ["Tower", "Crawler"] }));
    await inA((q) => repo.updateField(q, "cf_cap", { label: "Tonnes", options: ["ignored"] }));
    const fields = await inA((q) => repo.listFields(q, "deal"));
    expect(fields.find((f) => f.id === "cf_crane")).toMatchObject({ label: "Crane type", options: ["Tower", "Crawler"], kind: "choice" });
    expect(fields.find((f) => f.id === "cf_cap")).toMatchObject({ label: "Tonnes", options: [], kind: "number" });
  });

  it("stops at the per-record limit", async () => {
    await db.seed(`
      INSERT INTO custom_fields (id, sub_account_id, entity, label, kind)
      SELECT 'cf_n' || n, '${TENANT_A}', 'contact', 'Field ' || n, 'text' FROM generate_series(1, 28) n;`);
    const out = await inA((q) => repo.createField(q, "cf_over", "contact", { label: "One more", kind: "text", options: [] }));
    expect("error" in out && out.error).toMatch(/up to 30/);
  });

  it("never lists another workspace's fields", async () => {
    const labels = (await inA((q) => repo.listFields(q, "contact"))).map((f) => f.label);
    expect(labels).toEqual(["Inducted", "Gate code"]);
  });
});

describe("values", () => {
  it("STORES EACH KIND IN ITS OWN TYPE AND READS IT BACK IN ONE SHAPE", async () => {
    await inA((q) =>
      repo.saveValues(q, "deal", "d_a", [
        { field: { id: "cf_cap", kind: "number" }, value: "12.5" },
        { field: { id: "cf_start", kind: "date" }, value: "2026-10-01" },
        { field: { id: "cf_crane", kind: "choice" }, value: "Tower" },
      ])
    );
    await inA((q) => repo.saveValues(q, "contact", "ct_a", [{ field: { id: "cf_ind", kind: "yes_no" }, value: "no" }]));

    expect(await inA((q) => repo.valuesFor(q, "deal", ["d_a"]))).toEqual({
      d_a: { cf_cap: "12.5", cf_start: "2026-10-01", cf_crane: "Tower" },
    });
    expect(await inA((q) => repo.valuesFor(q, "contact", ["ct_a"]))).toEqual({ ct_a: { cf_ind: "no" } });
  });

  it("replaces a value, and clears it with null", async () => {
    const set = (value: string | null) =>
      inA((q) => repo.saveValues(q, "contact", "ct_a", [{ field: { id: "cf_gate", kind: "text" }, value }]));
    await set("1234");
    await set("9876");
    expect((await inA((q) => repo.valuesFor(q, "contact", ["ct_a"])))["ct_a"]).toEqual({ cf_gate: "9876" });
    await set(null);
    expect(await inA((q) => repo.valuesFor(q, "contact", ["ct_a"]))).toEqual({});
  });
});

describe("what the database refuses", () => {
  /* One refusal per test: two back-to-back parameterised errors desync the
     PGlite socket harness (see the failure log), not the database. */
  const insert = (sql: string) => db.seed(sql);

  it("REFUSES A NUMBER STORED AS TEXT", async () => {
    await expect(
      insert(`INSERT INTO custom_field_values (sub_account_id, field_id, deal_id, value_text)
              VALUES ('${TENANT_A}', 'cf_cap', 'd_a', '50')`)
    ).rejects.toThrow(/cannot hold that value/);
  });

  it("REFUSES A CONTACT FIELD ON A DEAL", async () => {
    await expect(
      insert(`INSERT INTO custom_field_values (sub_account_id, field_id, deal_id, value_bool)
              VALUES ('${TENANT_A}', 'cf_ind', 'd_a', TRUE)`)
    ).rejects.toThrow(/is for a contact/);
  });

  it("REFUSES ANOTHER WORKSPACE'S FIELD", async () => {
    await expect(
      insert(`INSERT INTO custom_field_values (sub_account_id, field_id, contact_id, value_text)
              VALUES ('${TENANT_A}', 'cf_other', 'ct_a', 'x')`)
    ).rejects.toThrow(/does not belong/);
  });

  it("REFUSES A VALUE ON ANOTHER WORKSPACE'S RECORD", async () => {
    await expect(
      insert(`INSERT INTO custom_field_values (sub_account_id, field_id, contact_id, value_text)
              VALUES ('${TENANT_A}', 'cf_gate', 'ct_b', 'x')`)
    ).rejects.toThrow(/does not belong/);
  });

  it("refuses a second value for the same field on the same record", async () => {
    await insert(`INSERT INTO custom_field_values (sub_account_id, field_id, contact_id, value_text)
                  VALUES ('${TENANT_A}', 'cf_gate', 'ct_a', 'one')`);
    await expect(
      insert(`INSERT INTO custom_field_values (sub_account_id, field_id, contact_id, value_text)
              VALUES ('${TENANT_A}', 'cf_gate', 'ct_a', 'two')`)
    ).rejects.toThrow(/custom_field_values_contact_once/);
  });
});

describe("from a posted form", () => {
  it("CHECKS EVERY VALUE BEFORE ANYTHING IS WRITTEN", async () => {
    const out = await inA((q) =>
      form.parseCustomValues(q, "deal", post({ "cf:cf_crane": "Tower", "cf:cf_cap": "lots" }))
    );
    expect(out).toEqual({ error: "Capacity must be a number." });
  });

  it("LEAVES A FIELD THE FORM DID NOT POST ALONE, and clears one posted empty", async () => {
    await inA((q) =>
      repo.saveValues(q, "deal", "d_a", [
        { field: { id: "cf_cap", kind: "number" }, value: "50" },
        { field: { id: "cf_crane", kind: "choice" }, value: "Tower" },
      ])
    );
    const changed = await inA(async (q) => {
      const parsed = await form.parseCustomValues(q, "deal", post({ "cf:cf_crane": "" }));
      if ("error" in parsed) throw new Error(parsed.error);
      return form.applyCustomValues(q, "deal", "d_a", parsed);
    });
    expect(changed).toEqual(["Crane"]);
    expect((await inA((q) => repo.valuesFor(q, "deal", ["d_a"])))["d_a"]).toEqual({ cf_cap: "50" });
  });

  it("ignores an archived field a stale page still posts", async () => {
    await inA((q) => repo.setFieldArchived(q, "cf_cap", true));
    const parsed = await inA((q) => form.parseCustomValues(q, "deal", post({ "cf:cf_cap": "99" })));
    expect(parsed).toEqual({ changes: [] });
  });

  it("names only the fields whose value actually changed", async () => {
    await inA((q) => repo.saveValues(q, "deal", "d_a", [{ field: { id: "cf_cap", kind: "number" }, value: "50" }]));
    const changed = await inA(async (q) => {
      const parsed = await form.parseCustomValues(q, "deal", post({ "cf:cf_cap": "50.0", "cf:cf_start": "2026-10-01" }));
      if ("error" in parsed) throw new Error(parsed.error);
      return form.applyCustomValues(q, "deal", "d_a", parsed);
    });
    expect(changed).toEqual(["Site open"]);
  });
});
