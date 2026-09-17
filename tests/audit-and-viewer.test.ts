import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The audit log, and the view-only role — through the real session path.
 *
 * `withCurrentTenant` is NOT mocked here. A real signed session cookie is
 * handed to it, so the role comes from the users table exactly as in
 * production; only the billing plan check is stood down.
 */

process.env.AUTH_SECRET = "test-secret-for-audit-and-viewer-0123456789";

const jar = globalThis as { __sessionCookie?: string };
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "yourcrm_session" && (globalThis as { __sessionCookie?: string }).__sessionCookie
        ? { value: (globalThis as { __sessionCookie?: string }).__sessionCookie }
        : undefined,
  }),
}));
vi.mock("@/server/plan-gate", () => ({ requireActivePlan: async () => {}, planState: async () => ({ active: true }) }));
vi.mock("@/server/revalidate", () => ({ revalidateApp: () => {} }));

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let withSystem: typeof import("../src/server/tenant").withSystem;
let logWrite: typeof import("../src/server/log").logWrite;
let session: typeof import("../src/server/tenant-session");
let contacts: typeof import("../src/app/(app)/contacts/actions");
let audit: typeof import("../src/server/repos/audit");
let createSessionToken: typeof import("../src/server/auth").createSessionToken;
let closePool: typeof import("../src/server/db").closePool;

const read = <T,>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));
const ctx: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant, withSystem } = await import("../src/server/tenant"));
  ({ logWrite } = await import("../src/server/log"));
  ({ closePool } = await import("../src/server/db"));
  ({ createSessionToken } = await import("../src/server/auth"));
  session = await import("../src/server/tenant-session");
  contacts = await import("../src/app/(app)/contacts/actions");
  audit = await import("../src/server/repos/audit");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  jar.__sessionCookie = undefined;
  await db.seed(`
    DELETE FROM contact_tags; DELETE FROM tags; DELETE FROM activities; DELETE FROM contacts;
    DELETE FROM users WHERE id = 'u_viewer';
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role)
      VALUES ('u_viewer', '${AGENCY}', '${TENANT_A}', 'viewer@test.local', 'x', 'Vera Viewer', 'viewer');
    INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES ('ct_1', '${TENANT_A}', 'Amara', 'Dube');
  `);
  /* Audit entries cannot be deleted row by row, by design; a fresh start per
     test goes around the trigger the way only a superuser can. */
  await db.seed(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only; DELETE FROM audit_events;
                 ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only;`);
});

describe("the audit log", () => {
  it("RECORDS A WRITE IN THE SAME TRANSACTION, naming the person as they were", async () => {
    await withTenant(ctx, async () => {
      logWrite("delete", "contact", { id: "ct_1", actor: USER_A, detail: "bulk delete" });
    });
    expect(await read(`SELECT actor_user_id, actor_name, action, entity, entity_id, detail FROM audit_events`)).toEqual([
      { actor_user_id: USER_A, actor_name: "Tester A", action: "delete", entity: "contact", entity_id: "ct_1", detail: "bulk delete" },
    ]);
  });

  it("A CHANGE THAT ROLLED BACK LEAVES NO ENTRY", async () => {
    await expect(
      withTenant(ctx, async () => {
        logWrite("create", "contact", { id: "ct_never" });
        throw new Error("the write failed after logging");
      })
    ).rejects.toThrow();
    expect(await read(`SELECT 1 FROM audit_events`)).toEqual([]);
  });

  it("a log line outside any workspace transaction is not stored anywhere", async () => {
    logWrite("create", "contact", { id: "ct_orphan" });
    expect(await read(`SELECT 1 FROM audit_events`)).toEqual([]);
  });

  it("a public visitor is recorded as one, with no person", async () => {
    await withTenant(ctx, async () => logWrite("create", "enquiry", { id: "d_1", actor: "public" }));
    expect(await read(`SELECT actor_user_id, detail FROM audit_events`)).toEqual([{ actor_user_id: null, detail: "Public visitor" }]);
  });

  it("A REAL ACTION LANDS IN THE LOG, and each workspace sees only its own", async () => {
    jar.__sessionCookie = createSessionToken(USER_A);
    expect(await contacts.addTagToContactAction("ct_1", { name: "Cape Town" })).toMatchObject({ ok: true });
    const mine = await withTenant(ctx, (q) => audit.listAuditEvents(q));
    expect(mine.map((e) => [e.action, e.entity])).toEqual([["create", "tag"]]);
    const theirs = await withTenant({ ...ctx, subAccountId: TENANT_B }, (q) => audit.listAuditEvents(q));
    expect(theirs).toEqual([]);
  });

  it("an entry cannot be edited or removed", async () => {
    await withTenant(ctx, async () => logWrite("update", "deal", { id: "d_1" }));
    await expect(db.seed(`UPDATE audit_events SET detail = 'rewritten'`)).rejects.toThrow(/cannot be changed or removed/);
  });
});

describe("view only", () => {
  /* The refusal is Postgres's own (25006, read_only_sql_transaction), proven
     through the real action below. One refused statement per file: the test
     database desyncs on two in a row (see the failure log). */
  it("A VIEWER'S CHANGE IS REFUSED WITH A SENTENCE, and nothing is written — through the real session", async () => {
    jar.__sessionCookie = createSessionToken("u_viewer");
    expect(await contacts.addTagToContactAction("ct_1", { name: "Cape Town" })).toEqual({ error: session.VIEW_ONLY_MESSAGE });
    expect(await read(`SELECT 1 FROM tags`)).toEqual([]);
    expect(await read(`SELECT 1 FROM audit_events`)).toEqual([]);
  });

  it("a viewer can still read", async () => {
    jar.__sessionCookie = createSessionToken("u_viewer");
    const names = await session.withCurrentTenant((q) =>
      q.rows<{ first_name: string }>(`SELECT first_name FROM contacts WHERE sub_account_id = $1`, [q.ctx.subAccountId])
    );
    expect(names).toEqual([{ first_name: "Amara" }]);
  });

  it("A VIEWER'S PAGE LOAD STILL DOES ITS OWN HOUSEKEEPING — only actions are read-only", async () => {
    jar.__sessionCookie = createSessionToken("u_viewer");
    const housekeeping = await session.withTenantPage((q) =>
      q.rows<{ id: string }>(
        `INSERT INTO tags (id, sub_account_id, name, color) VALUES ('tg_page', $1, 'Page write', 'blue') RETURNING id`,
        [q.ctx.subAccountId]
      )
    );
    expect(housekeeping).toEqual([{ id: "tg_page" }]);
  });

  it("the same action works for somebody who may change things", async () => {
    jar.__sessionCookie = createSessionToken(USER_A);
    expect(await contacts.addTagToContactAction("ct_1", { name: "Cape Town" })).toMatchObject({ ok: true });
  });
});
