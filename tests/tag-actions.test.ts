import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B } from "./helpers/pg";

/**
 * Tags and saved views through the controls on the contacts screen: who may
 * do what, typing a name that already exists, and counts that are true.
 */

const as = globalThis as { __tagRole?: string };

vi.mock("@/server/tenant-session", () => {
  const run = async <T,>(fn: (q: unknown) => Promise<T>) => {
    const pg = await import("./helpers/pg");
    const { withTenant } = await import("../src/server/tenant");
    const role = ((globalThis as { __tagRole?: string }).__tagRole ?? "owner") as "owner";
    return withTenant({ agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role }, (q) => fn(q));
  };
  return { withCurrentTenant: run };
});
vi.mock("@/server/revalidate", () => ({ revalidateApp: () => {} }));

let db: TestDb;
let actions: typeof import("../src/app/(app)/contacts/actions");
let withSystem: typeof import("../src/server/tenant").withSystem;
let closePool: typeof import("../src/server/db").closePool;

const read = <T,>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));
const tagsOn = async (contactId: string) =>
  (
    await read<{ name: string }>(
      `SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = '${contactId}' ORDER BY t.name`
    )
  ).map((r) => r.name);

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  actions = await import("../src/app/(app)/contacts/actions");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  as.__tagRole = "owner";
  await db.seed(`
    DELETE FROM contact_views; DELETE FROM contact_tags; DELETE FROM tags; DELETE FROM activities; DELETE FROM contacts;
    INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES
      ('ct_1', '${TENANT_A}', 'Amara', 'Dube'),
      ('ct_2', '${TENANT_A}', 'Ben', 'Cole'),
      ('ct_b', '${TENANT_B}', 'Bruno', 'Beta');
    INSERT INTO tags (id, sub_account_id, name, color) VALUES
      ('tg_cpt', '${TENANT_A}', 'Cape Town', 'blue'),
      ('tg_b',   '${TENANT_B}', 'Theirs', 'red');
    INSERT INTO contact_views (id, sub_account_id, name, filter, created_by_user_id) VALUES
      ('cv_orphan', '${TENANT_A}', 'From somebody who left', '{"type":"lead","tagIds":[],"match":"any"}', NULL);
  `);
});

describe("tagging one contact", () => {
  it("REUSES A TAG TYPED IN DIFFERENT CAPITALS rather than making a second one", async () => {
    const out = await actions.addTagToContactAction("ct_1", { name: "  cape   TOWN " });
    expect(out).toMatchObject({ ok: true, tag: { id: "tg_cpt" } });
    expect(await read(`SELECT id FROM tags WHERE sub_account_id = '${TENANT_A}'`)).toHaveLength(1);
    expect(await tagsOn("ct_1")).toEqual(["Cape Town"]);
  });

  it("makes a new tag in a colour not yet used, and records it on the person's history", async () => {
    /* Blue and amber taken: the first free colour is green, which is not what
       simply counting the tags would pick. */
    await db.seed(`INSERT INTO tags (id, sub_account_id, name, color) VALUES ('tg_hot', '${TENANT_A}', 'Hot', 'amber')`);
    const out = await actions.addTagToContactAction("ct_1", { name: "Decision maker" });
    expect(out).toMatchObject({ ok: true, tag: { name: "Decision maker", color: "green" } });
    const [entry] = await read<{ title: string; detail: string }>(`SELECT title, detail FROM activities WHERE entity_id = 'ct_1'`);
    expect(entry).toEqual({ title: "Tag added", detail: "Decision maker" });
  });

  it("a member may tag — it is the work", async () => {
    as.__tagRole = "member";
    expect(await actions.addTagToContactAction("ct_1", { tagId: "tg_cpt" })).toMatchObject({ ok: true });
  });

  it("refuses another workspace's tag and another workspace's contact", async () => {
    expect(await actions.addTagToContactAction("ct_1", { tagId: "tg_b" })).toEqual({ error: "That tag no longer exists." });
    expect(await actions.addTagToContactAction("ct_b", { tagId: "tg_cpt" })).toEqual({ error: "That contact no longer exists." });
    expect(await read(`SELECT 1 FROM contact_tags`)).toHaveLength(0);
  });

  it("refuses a blank name", async () => {
    expect(await actions.addTagToContactAction("ct_1", { name: "   " })).toEqual({ error: "Type a name for the tag." });
  });

  it("takes one off, and says so in the history", async () => {
    await actions.addTagToContactAction("ct_1", { tagId: "tg_cpt" });
    expect(await actions.removeTagFromContactAction("ct_1", "tg_cpt")).toEqual({ ok: true });
    expect(await tagsOn("ct_1")).toEqual([]);
    expect((await read<{ title: string }>(`SELECT title FROM activities ORDER BY at DESC LIMIT 1`))[0].title).toBe("Tag removed");
  });
});

describe("tagging a selection", () => {
  it("COUNTS WHAT CHANGED, not what was selected", async () => {
    await actions.addTagToContactAction("ct_1", { tagId: "tg_cpt" });
    expect(await actions.bulkTagContactsAction(["ct_1", "ct_2", "ct_b"], "tg_cpt", true)).toEqual({ ok: true, changed: 1 });
    expect(await actions.bulkTagContactsAction(["ct_1", "ct_2"], "tg_cpt", false)).toEqual({ ok: true, changed: 2 });
  });

  it("refuses a tag from another workspace outright", async () => {
    expect(await actions.bulkTagContactsAction(["ct_1"], "tg_b", true)).toEqual({ error: "That tag no longer exists." });
  });
});

describe("renaming and deleting tags", () => {
  it("REFUSES A MEMBER, for rename and delete alike", async () => {
    as.__tagRole = "member";
    expect(await actions.updateTagAction("tg_cpt", "CPT", "red")).toEqual({ error: expect.stringMatching(/manages the team/) });
    expect(await actions.deleteTagAction("tg_cpt")).toEqual({ error: expect.stringMatching(/manages the team/) });
    expect(await read(`SELECT name, color FROM tags WHERE id = 'tg_cpt'`)).toEqual([{ name: "Cape Town", color: "blue" }]);
  });

  it("renames and recolours for an owner, refusing a colour that is not one", async () => {
    expect(await actions.updateTagAction("tg_cpt", " CPT ", "teal")).toEqual({ ok: true });
    expect(await actions.updateTagAction("tg_cpt", "CPT", "chartreuse")).toEqual({ error: "Choose one of the colours." });
    expect(await read(`SELECT name, color FROM tags WHERE id = 'tg_cpt'`)).toEqual([{ name: "CPT", color: "teal" }]);
  });

  it("deletes for an owner, leaving the contacts", async () => {
    await actions.addTagToContactAction("ct_1", { tagId: "tg_cpt" });
    expect(await actions.deleteTagAction("tg_cpt")).toEqual({ ok: true });
    expect(await read(`SELECT id FROM contacts WHERE sub_account_id = '${TENANT_A}'`)).toHaveLength(2);
    expect(await actions.deleteTagAction("tg_b")).toEqual({ error: "That tag no longer exists." });
  });
});

describe("saved views", () => {
  it("SAVES WHAT IT CAN USE: an unknown tag is dropped, and a view of everybody is refused", async () => {
    const out = await actions.saveViewAction("CPT", { type: "all", tagIds: ["tg_cpt", "tg_b"], match: "any" });
    expect(out).toMatchObject({ ok: true, view: { filter: { tagIds: ["tg_cpt"] } } });
    expect(await actions.saveViewAction("Everybody", { type: "all", tagIds: ["tg_b"], match: "any" })).toEqual({
      error: expect.stringMatching(/would show everybody/),
    });
  });

  it("LETS WHOEVER SAVED IT DELETE IT, and nobody else below a manager", async () => {
    as.__tagRole = "member";
    const mine = await actions.saveViewAction("Mine", { type: "client", tagIds: [], match: "any" });
    if (!("view" in mine)) throw new Error("not saved");
    expect(await actions.deleteViewAction("cv_orphan")).toEqual({ error: expect.stringMatching(/Only whoever saved/) });
    expect(await actions.deleteViewAction(mine.view.id)).toEqual({ ok: true });

    as.__tagRole = "owner";
    expect(await actions.deleteViewAction("cv_orphan")).toEqual({ ok: true });
    expect(await read(`SELECT id FROM contact_views`)).toEqual([]);
  });
});
