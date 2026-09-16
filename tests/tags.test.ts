import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/** Tags and saved views on a real Postgres. */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let repo: typeof import("../src/server/repos/tags");
let closePool: typeof import("../src/server/db").closePool;

const ctx = (sub: string): TenantContext => ({ agencyId: AGENCY, subAccountId: sub, userId: USER_A, role: "owner" });
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctx(TENANT_A), fn);

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/tags");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM contact_views; DELETE FROM contact_tags; DELETE FROM tags; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES
      ('ct_1', '${TENANT_A}', 'Amara', 'Dube'),
      ('ct_2', '${TENANT_A}', 'Ben', 'Cole'),
      ('ct_gone', '${TENANT_A}', 'Old', 'Deleted'),
      ('ct_b', '${TENANT_B}', 'Bruno', 'Beta');
    UPDATE contacts SET deleted_at = now() WHERE id = 'ct_gone';
    INSERT INTO tags (id, sub_account_id, name, color) VALUES
      ('tg_cpt', '${TENANT_A}', 'Cape Town', 'teal'),
      ('tg_b',   '${TENANT_B}', 'Theirs', 'red');
  `)
);

describe("tags", () => {
  it("creates one, and refuses a second with the same name in any case — keeping the request usable", async () => {
    const out = await inA(async (q) => {
      const first = await repo.createTag(q, "Decision maker", "purple");
      const again = await repo.createTag(q, "CAPE TOWN", "blue");
      return { first, again, all: (await repo.listTags(q)).map((t) => t.name) };
    });
    expect("tag" in out.first).toBe(true);
    expect(out.again).toEqual({ error: "There is already a tag called “CAPE TOWN”." });
    expect(out.all).toEqual(["Cape Town", "Decision maker"]);
  });

  it("finds an existing tag by name ignoring case, so typing reuses it", async () => {
    expect((await inA((q) => repo.findTagByName(q, "cape TOWN")))?.id).toBe("tg_cpt");
  });

  it("TAGS A SELECTION IN ONE GO and counts only what changed", async () => {
    const first = await inA((q) => repo.setTagOnContacts(q, "tg_cpt", ["ct_1", "ct_2", "ct_gone", "ct_b"], true));
    expect(first, "a deleted contact or another workspace's was tagged").toBe(2);
    const again = await inA((q) => repo.setTagOnContacts(q, "tg_cpt", ["ct_1"], true));
    expect(again, "an already-tagged contact was counted").toBe(0);
    expect(await inA((q) => repo.tagIdsByContact(q))).toEqual({ ct_1: ["tg_cpt"], ct_2: ["tg_cpt"] });
    expect((await inA((q) => repo.listTags(q)))[0].contacts).toBe(2);
  });

  it("CANNOT PUT ANOTHER WORKSPACE'S TAG ON A CONTACT", async () => {
    expect(await inA((q) => repo.setTagOnContacts(q, "tg_b", ["ct_1"], true))).toBe(0);
    expect(await inA((q) => repo.tagIdsByContact(q))).toEqual({});
  });

  it("the database refuses it even when asked directly", async () => {
    await expect(
      db.seed(`INSERT INTO contact_tags (sub_account_id, contact_id, tag_id) VALUES ('${TENANT_A}', 'ct_1', 'tg_b')`)
    ).rejects.toThrow(/tag tg_b does not belong/);
  });

  it("takes a tag off", async () => {
    await inA((q) => repo.setTagOnContacts(q, "tg_cpt", ["ct_1", "ct_2"], true));
    expect(await inA((q) => repo.setTagOnContacts(q, "tg_cpt", ["ct_2"], false))).toBe(1);
    expect(await inA((q) => repo.tagIdsByContact(q))).toEqual({ ct_1: ["tg_cpt"] });
  });

  it("DELETING A TAG REMOVES THE LABEL AND LEAVES EVERY CONTACT", async () => {
    await inA((q) => repo.setTagOnContacts(q, "tg_cpt", ["ct_1"], true));
    expect(await inA((q) => repo.deleteTag(q, "tg_cpt"))).toBe(true);
    const [left] = await inA((q) => q.rows<{ n: number }>(`SELECT count(*)::int AS n FROM contacts WHERE sub_account_id = $1`, [TENANT_A]));
    expect(left.n).toBe(3);
    expect(await inA((q) => repo.tagIdsByContact(q))).toEqual({});
  });

  it("renames and recolours, refusing a clash", async () => {
    await inA((q) => repo.createTag(q, "Cold", "slate"));
    expect(await inA((q) => repo.updateTag(q, "tg_cpt", { name: "Cape Town CBD", color: "green" }))).toEqual({ ok: true });
    expect(await inA((q) => repo.updateTag(q, "tg_cpt", { name: "cold", color: "green" }))).toEqual({
      error: "There is already a tag called “cold”.",
    });
  });
});

describe("saved views", () => {
  it("SAVES A FILTER AND OPENS IT AGAIN, dropping a tag deleted since", async () => {
    await inA((q) => repo.saveView(q, "CPT leads", { type: "lead", tagIds: ["tg_cpt", "tg_since_deleted"], match: "all" }));
    const views = await inA((q) => repo.listViews(q, new Set(["tg_cpt"])));
    expect(views).toEqual([
      { id: expect.any(String), name: "CPT leads", filter: { type: "lead", tagIds: ["tg_cpt"], match: "all" }, createdBy: USER_A },
    ]);
  });

  it("refuses a second view with the same name, and deletes one", async () => {
    const first = await inA((q) => repo.saveView(q, "Hot", { type: "all", tagIds: [], match: "any" }));
    expect(await inA((q) => repo.saveView(q, "HOT", { type: "all", tagIds: [], match: "any" }))).toEqual({
      error: "There is already a view called “HOT”.",
    });
    if ("view" in first) expect(await inA((q) => repo.deleteView(q, first.view.id))).toBe(true);
    expect(await inA((q) => repo.listViews(q, new Set()))).toEqual([]);
  });

  it("never shows another workspace's tags or views", async () => {
    await withTenant(ctx(TENANT_B), (q) => repo.saveView(q, "Theirs", { type: "all", tagIds: [], match: "any" }));
    expect((await inA((q) => repo.listTags(q))).map((t) => t.id)).toEqual(["tg_cpt"]);
    expect(await inA((q) => repo.listViews(q, new Set()))).toEqual([]);
  });
});
