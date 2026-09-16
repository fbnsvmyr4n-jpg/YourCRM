import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, TENANT_A } from "./helpers/pg";

/**
 * Custom fields through the forms people actually use: who may define them,
 * and whether a value typed into Edit Contact or Edit details really lands —
 * or is refused before anything is written.
 */

const as = globalThis as { __cfRole?: string };

vi.mock("@/server/tenant-session", () => {
  const run = async <T,>(fn: (q: unknown) => Promise<T>) => {
    const pg = await import("./helpers/pg");
    const { withTenant } = await import("../src/server/tenant");
    const role = ((globalThis as { __cfRole?: string }).__cfRole ?? "owner") as "owner";
    return withTenant({ agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role }, (q) => fn(q));
  };
  return {
    withCurrentTenant: run,
    requireTenant: async () => {
      const pg = await import("./helpers/pg");
      return { agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role: "owner" };
    },
  };
});
vi.mock("@/server/revalidate", () => ({ revalidateApp: () => {} }));

let db: TestDb;
let settings: typeof import("../src/app/(app)/settings/custom-field-actions");
let contacts: typeof import("../src/app/(app)/contacts/actions");
let projects: typeof import("../src/app/(app)/projects/actions");
let withSystem: typeof import("../src/server/tenant").withSystem;
let closePool: typeof import("../src/server/db").closePool;

const read = <T>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  settings = await import("../src/app/(app)/settings/custom-field-actions");
  contacts = await import("../src/app/(app)/contacts/actions");
  projects = await import("../src/app/(app)/projects/actions");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  as.__cfRole = "owner";
  await db.seed(`
    DELETE FROM custom_field_values; DELETE FROM custom_fields; DELETE FROM activities;
    DELETE FROM deals; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email)
      VALUES ('ct_a', '${TENANT_A}', 'Amara', 'Dube', 'amara@test.local');
    INSERT INTO deals (id, sub_account_id, title, value_cents, stage)
      VALUES ('d_a', '${TENANT_A}', 'Warehouse', 0, 'discovery');
    INSERT INTO custom_fields (id, sub_account_id, entity, label, kind, options, position) VALUES
      ('cf_gate', '${TENANT_A}', 'contact', 'Gate code', 'text',   '{}', 1),
      ('cf_ind',  '${TENANT_A}', 'contact', 'Inducted',  'yes_no', '{}', 2),
      ('cf_cap',  '${TENANT_A}', 'deal',    'Capacity',  'number', '{}', 1);
  `);
});

describe("defining a field in Settings", () => {
  it("adds a choice list with its choices", async () => {
    const out = await settings.createCustomFieldAction(
      undefined,
      form({ entity: "deal", label: "Crane", kind: "choice", options: "Tower\nMobile" })
    );
    expect(out).toEqual({ ok: "Added “Crane”." });
    const [row] = await read<{ options: string[] }>(`SELECT options FROM custom_fields WHERE label = 'Crane'`);
    expect(row.options).toEqual(["Tower", "Mobile"]);
  });

  it("REFUSES A MEMBER, for adding, editing and archiving alike", async () => {
    as.__cfRole = "member";
    expect((await settings.createCustomFieldAction(undefined, form({ entity: "deal", label: "X", kind: "text" })))?.error).toMatch(/manages the team/);
    expect((await settings.updateCustomFieldAction(undefined, form({ id: "cf_cap", label: "Y" })))?.error).toMatch(/manages the team/);
    expect((await settings.setCustomFieldArchivedAction(undefined, form({ id: "cf_cap", archived: "true" })))?.error).toMatch(/manages the team/);
    const rows = await read<{ label: string; archived_at: Date | null }>(`SELECT label, archived_at FROM custom_fields WHERE id = 'cf_cap'`);
    expect(rows).toEqual([{ label: "Capacity", archived_at: null }]);
  });

  it("CANNOT TURN A NUMBER FIELD INTO A CHOICE LIST by posting a different kind", async () => {
    /* Found by a mutation run: validating against the POSTED kind survived,
       because the repository never writes the kind anyway. What it broke was
       the rename itself — a claimed choice list with no choices refused a
       perfectly good new name. The field's own kind is what an edit is
       checked against. */
    expect(
      await settings.updateCustomFieldAction(undefined, form({ id: "cf_cap", label: "Tonnes", kind: "choice" }))
    ).toEqual({ ok: "Saved." });
    await settings.updateCustomFieldAction(undefined, form({ id: "cf_cap", label: "Tonnes", kind: "choice", options: "a" }));
    const [row] = await read<{ label: string; kind: string; options: string[] }>(`SELECT label, kind, options FROM custom_fields WHERE id = 'cf_cap'`);
    expect(row).toEqual({ label: "Tonnes", kind: "number", options: [] });
  });

  it("archives, and says what happens to the values", async () => {
    expect(await settings.setCustomFieldArchivedAction(undefined, form({ id: "cf_cap", archived: "true" }))).toEqual({
      ok: "Archived. What people typed is kept.",
    });
  });
});

describe("filling fields in on a contact", () => {
  const edit = (extra: Record<string, string>) =>
    contacts.updateContactAction("ct_a", form({ firstName: "Amara", lastName: "Dube", email: "amara@test.local", ...extra }));

  it("SAVES THE VALUES AND NAMES THEM IN THE CONTACT'S HISTORY", async () => {
    await edit({ "cf:cf_gate": "4471", "cf:cf_ind": "yes" });
    const values = await read<{ field_id: string; value_text: string | null; value_bool: boolean | null }>(
      `SELECT field_id, value_text, value_bool FROM custom_field_values ORDER BY field_id`
    );
    expect(values).toEqual([
      { field_id: "cf_gate", value_text: "4471", value_bool: null },
      { field_id: "cf_ind", value_text: null, value_bool: true },
    ]);
    const [log] = await read<{ detail: string }>(`SELECT detail FROM activities WHERE entity_id = 'ct_a'`);
    expect(log.detail).toBe("Gate code, Inducted");
  });

  it("REFUSES A BAD VALUE WITH A SENTENCE, and saves nothing else from that edit", async () => {
    const out = await edit({ "cf:cf_ind": "perhaps", lastName: "Dube-Smith" });
    expect(out).toEqual({ error: "Inducted must be yes or no." });
    const [c] = await read<{ last_name: string }>(`SELECT last_name FROM contacts WHERE id = 'ct_a'`);
    expect(c.last_name, "the contact was changed by an edit that was refused").toBe("Dube");
  });

  it("saves values on a brand-new contact", async () => {
    const id = await contacts.addContactAction(
      form({ firstName: "Ben", lastName: "Cole", email: "ben@test.local", "cf:cf_gate": "9" })
    );
    expect(typeof id).toBe("string");
    const [v] = await read<{ contact_id: string; value_text: string }>(`SELECT contact_id, value_text FROM custom_field_values`);
    expect(v).toEqual({ contact_id: id, value_text: "9" });
  });

  it("does not create the contact when a value is refused", async () => {
    const out = await contacts.addContactAction(
      form({ firstName: "Ben", lastName: "Cole", email: "ben@test.local", "cf:cf_ind": "later" })
    );
    expect(out).toEqual({ error: "Inducted must be yes or no." });
    expect(await read(`SELECT id FROM contacts WHERE email = 'ben@test.local'`)).toHaveLength(0);
  });
});

describe("filling fields in on a project", () => {
  it("saves a number typed the way people type it", async () => {
    const out = await projects.updateProjectAction(undefined, form({ dealId: "d_a", site: "Paarl", "cf:cf_cap": "12 500" }));
    expect(out).toEqual({ ok: "Project updated." });
    const [v] = await read<{ n: string }>(`SELECT value_number::text AS n FROM custom_field_values`);
    expect(Number(v.n)).toBe(12500);
  });

  it("refuses a bad value before the site or dates change", async () => {
    const out = await projects.updateProjectAction(undefined, form({ dealId: "d_a", site: "Paarl", "cf:cf_cap": "lots" }));
    expect(out).toEqual({ error: "Capacity must be a number." });
    const [d] = await read<{ site: string | null }>(`SELECT site FROM deals WHERE id = 'd_a'`);
    expect(d.site).toBeNull();
  });
});
