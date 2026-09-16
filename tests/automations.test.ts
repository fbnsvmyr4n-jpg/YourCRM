import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext, TenantQuery } from "../src/server/tenant";

/**
 * The automation engine, on a real Postgres, through the real entry points.
 *
 * Deals are created and moved through the repository exactly as every screen
 * does it — and once through the public enquiry form — so these prove the
 * rules run for leads nobody wired up by hand, not just for a function called
 * directly.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let withSystem: typeof import("../src/server/tenant").withSystem;
let deals: typeof import("../src/server/repos/deals");
let notifications: typeof import("../src/server/notifications");
let enquiry: typeof import("../src/server/enquiry/enquire");
let closePool: typeof import("../src/server/db").closePool;

const ctxA: TenantContext = { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" };
const inA = <T>(fn: (q: TenantQuery) => Promise<T>) => withTenant(ctxA, fn);
const read = <T>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));

const list = (ids: string[]) => `ARRAY[${ids.map((i) => `'${i}'`).join(", ")}]::text[]`;

/** A lead rule. `minutesAgo` orders rules the way their creation would. */
const assignRule = (id: string, ids: string[], opts: { source?: string; tenant?: string; minutesAgo?: number } = {}) =>
  db.seed(`
    INSERT INTO automations (id, sub_account_id, event_kind, when_source, action_kind, assignee_ids, created_at)
    VALUES ('${id}', '${opts.tenant ?? TENANT_A}', 'lead_created', ${opts.source ? `'${opts.source}'` : "NULL"},
            'assign_owner', ${list(ids)}, now() - interval '${opts.minutesAgo ?? 10} minutes');`);

const moveRule = (id: string, when: string, target: string, minutesAgo = 10) =>
  db.seed(`
    INSERT INTO automations (id, sub_account_id, event_kind, when_stage, action_kind, target_stage, created_at)
    VALUES ('${id}', '${TENANT_A}', 'deal_stage_changed', '${when}', 'move_stage', '${target}',
            now() - interval '${minutesAgo} minutes');`);

const newLead = (over: Partial<import("../src/server/repos/deals").NewDeal> = {}) =>
  inA((q) =>
    deals.createDeal(q, {
      title: "Amara Dube — crane hire",
      stage: "prospect",
      source: "website",
      ownerUserId: USER_A,
      ...over,
    })
  );

const runs = () =>
  read<{ automation_id: string; outcome: string; detail: string }>(
    `SELECT automation_id, outcome, detail FROM automation_runs ORDER BY at, id`
  );

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant, withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  deals = await import("../src/server/repos/deals");
  notifications = await import("../src/server/notifications");
  enquiry = await import("../src/server/enquiry/enquire");
  await db.seed(`
    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role) VALUES
      ('u_sam',  '${AGENCY}', NULL, 'sam@test.local',  'x', 'Sam Lee',  'member'),
      ('u_kim',  '${AGENCY}', NULL, 'kim@test.local',  'x', 'Kim Park', 'member'),
      ('u_it',   '${AGENCY}', NULL, 'it@test.local',   'x', 'Ira Tech', 'admin'),
      ('u_gone', '${AGENCY}', NULL, 'gone@test.local', 'x', 'Gil Gone', 'member');
    UPDATE users SET deleted_at = now() WHERE id = 'u_gone';
  `);
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM todos; DELETE FROM automation_runs; DELETE FROM automations; DELETE FROM activities;
    DELETE FROM deals; DELETE FROM contacts; DELETE FROM booking_links;
  `)
);

describe("adding a task", () => {
  const taskRule = (id: string, title: string, days: number, minutesAgo = 5) =>
    db.seed(`
      INSERT INTO automations (id, sub_account_id, event_kind, action_kind, task_title, task_due_days, created_at)
      VALUES ('${id}', '${TENANT_A}', 'lead_created', 'create_task', '${title}', ${days},
              now() - interval '${minutesAgo} minutes');`);

  it("GIVES THE TASK TO WHOEVER AN EARLIER RULE JUST ASSIGNED THE LEAD TO", async () => {
    await assignRule("au_route", ["u_kim"], { minutesAgo: 20 });
    await taskRule("au_call", "Call them back", 1, 10);
    await db.seed(`INSERT INTO contacts (id, sub_account_id, first_name, last_name) VALUES ('ct_new', '${TENANT_A}', 'Amara', 'Dube');`);
    const deal = await newLead({ contactId: "ct_new" });

    const [task] = await read<{ title: string; assignee_user_id: string; deal_id: string; contact_id: string;
      automation_id: string; created_by_user_id: string | null; due_on: string; today: string }>(
      `SELECT title, assignee_user_id, deal_id, contact_id, automation_id, created_by_user_id,
              due_on::text AS due_on, (CURRENT_DATE + 1)::text AS today FROM todos`
    );
    expect(task).toMatchObject({
      title: "Call them back",
      assignee_user_id: "u_kim",
      deal_id: deal.id,
      contact_id: "ct_new",
      automation_id: "au_call",
      created_by_user_id: null,
    });
    expect(task.due_on, "due a day after the lead, on the business's calendar").toBe(task.today);
    expect((await runs()).map((r) => `${r.automation_id}:${r.outcome}`)).toEqual(["au_route:done", "au_call:done"]);
  });

  it("LEAVES THE TASK FOR NOBODY RATHER THAN ON THE DESK OF SOMEBODY WHO HAS LEFT", async () => {
    await taskRule("au_call", "Call them back", 0);
    await newLead({ ownerUserId: "u_it" });
    const [task] = await read<{ assignee_user_id: string | null }>(`SELECT assignee_user_id FROM todos`);
    expect(task.assignee_user_id).toBeNull();
    const [run] = await runs();
    expect(run.detail).toMatch(/for nobody yet/);
  });
});

describe("the engine is switched on", () => {
  it("IS REGISTERED BY THE MODULE EVERY SERVER PATH LOADS", () => {
    // A listener nobody registered fails by doing nothing, so this is pinned.
    const tenant = readFileSync(join(__dirname, "..", "src", "server", "tenant.ts"), "utf8");
    expect(tenant).toMatch(/^import "\.\/automations";$/m);
  });

  it("does not put the engine in the client bundle: the deals repository imports only the event module", () => {
    const repo = readFileSync(join(__dirname, "..", "src", "server", "repos", "deals.ts"), "utf8");
    expect(repo).not.toMatch(/from "\.\.\/automations"/);
    expect(repo).toMatch(/from "\.\.\/deal-events"/);
  });
});

describe("handing a new lead to somebody", () => {
  it("GIVES A NEW LEAD TO THE PERSON THE RULE NAMES, and says so on the deal", async () => {
    await assignRule("au_web", ["u_sam"]);
    const deal = await newLead();

    expect(deal.ownerUserId, "the caller was handed the deal as it was before the rule ran").toBe("u_sam");
    const [stored] = await read<{ owner_user_id: string }>(`SELECT owner_user_id FROM deals`);
    expect(stored.owner_user_id).toBe("u_sam");

    const [note] = await read<{ title: string; detail: string; actor_user_id: string | null }>(
      `SELECT title, detail, actor_user_id FROM activities WHERE entity_id = '${deal.id}'`
    );
    expect(note.title).toBe("Assigned to Sam Lee");
    expect(note.detail).toContain("A new lead comes in → Give it to Sam Lee");
    expect(note.actor_user_id, "a rule's change was attributed to a person").toBeNull();

    expect(await runs()).toEqual([{ automation_id: "au_web", outcome: "done", detail: "Assigned to Sam Lee" }]);
  });

  it("moves a brand-new person with their lead", async () => {
    await db.seed(`INSERT INTO contacts (id, sub_account_id, first_name, last_name, owner_user_id)
                   VALUES ('ct_new', '${TENANT_A}', 'Amara', 'Dube', '${USER_A}');`);
    await assignRule("au_web", ["u_sam"]);
    await newLead({ contactId: "ct_new" });
    const [c] = await read<{ owner_user_id: string }>(`SELECT owner_user_id FROM contacts`);
    expect(c.owner_user_id).toBe("u_sam");
  });

  it("LEAVES AN EXISTING CLIENT WITH THE COLLEAGUE WHO LOOKS AFTER THEM", async () => {
    await db.seed(`INSERT INTO contacts (id, sub_account_id, first_name, last_name, owner_user_id)
                   VALUES ('ct_known', '${TENANT_A}', 'Amara', 'Dube', 'u_kim');`);
    await assignRule("au_web", ["u_sam"]);
    await newLead({ contactId: "ct_known" });
    const [c] = await read<{ owner_user_id: string }>(`SELECT owner_user_id FROM contacts`);
    expect(c.owner_user_id, "a lead rule took a relationship off a colleague").toBe("u_kim");
  });

  it("only acts on leads from the source it names", async () => {
    await assignRule("au_web", ["u_sam"], { source: "website" });
    const phone = await newLead({ source: "phone_call" });
    expect(phone.ownerUserId).toBe(USER_A);
    expect(await runs()).toEqual([]);
  });

  it("TAKES TURNS, AND REMEMBERS WHOSE TURN IS NEXT", async () => {
    await assignRule("au_rota", ["u_sam", "u_kim"]);
    const owners = [];
    for (let i = 0; i < 3; i++) owners.push((await newLead({ title: `Lead ${i}` })).ownerUserId);
    expect(owners).toEqual(["u_sam", "u_kim", "u_sam"]);
    const [r] = await read<{ rotation_position: number }>(`SELECT rotation_position FROM automations`);
    expect(r.rotation_position).toBe(1);
  });

  it("steps over somebody who left and somebody who cannot open customer records", async () => {
    await assignRule("au_rota", ["u_gone", "u_it", "u_kim"]);
    expect((await newLead()).ownerUserId).toBe("u_kim");
  });

  it("does not treat a deal created straight into Closed Won as a lead", async () => {
    await assignRule("au_web", ["u_sam"]);
    const won = await newLead({ stage: "won" });
    expect(won.ownerUserId).toBe(USER_A);
    expect(await runs()).toEqual([]);
  });

  it("ignores a switched-off rule, and another workspace's rules entirely", async () => {
    await assignRule("au_off", ["u_sam"]);
    await db.seed(`UPDATE automations SET enabled = FALSE`);
    await assignRule("au_b", ["u_kim"], { tenant: TENANT_B });
    expect((await newLead()).ownerUserId).toBe(USER_A);
    expect(await runs()).toEqual([]);
  });
});

describe("when a rule cannot run", () => {
  it("STILL SAVES THE LEAD, records why, and rings the bell", async () => {
    await assignRule("au_empty", ["u_gone", "u_it"]);
    const deal = await newLead();

    const [stored] = await read<{ id: string; owner_user_id: string }>(`SELECT id, owner_user_id FROM deals`);
    expect(stored.id, "a failing rule lost the lead it was meant to route").toBe(deal.id);
    expect(stored.owner_user_id).toBe(USER_A);

    const [run] = await runs();
    expect(run.outcome).toBe("failed");
    expect(run.detail).toMatch(/Nobody on this automation can take work/);

    const feed = await inA((q) => notifications.listNotifications(q));
    const item = feed.find((n) => n.id === "automations-failing");
    expect(item?.title).toBe("1 automation could not run");
    expect(item?.href).toBe("/settings?s=automations");
  });

  it("stops ringing once the rule has worked since", async () => {
    await assignRule("au_empty", ["u_gone"]);
    await newLead({ title: "First" });
    await db.seed(`UPDATE automations SET assignee_ids = ARRAY['u_kim']::text[]`);
    await newLead({ title: "Second" });
    const feed = await inA((q) => notifications.listNotifications(q));
    expect(feed.find((n) => n.id === "automations-failing")).toBeUndefined();
  });
});

describe("moving a deal on", () => {
  beforeEach(() =>
    db.seed(`INSERT INTO deals (id, sub_account_id, title, value_cents, stage, owner_user_id)
             VALUES ('d_job', '${TENANT_A}', 'Warehouse', 1000000, 'demo', '${USER_A}');`)
  );

  it("MOVES A WON DEAL INTO DELIVERY, keeping the day it was won", async () => {
    await moveRule("au_deliver", "won", "delivery");
    const moved = await inA((q) => deals.moveStage(q, "d_job", "won"));
    expect(moved?.stage).toBe("delivery");
    expect(moved?.wonAt, "the win stopped counting when delivery started").not.toBeNull();
    expect(await runs()).toEqual([
      { automation_id: "au_deliver", outcome: "done", detail: "Moved from Closed Won to Delivery" },
    ]);
  });

  it("does nothing when a card is dropped back into its own column", async () => {
    await moveRule("au_deliver", "demo", "won");
    await inA((q) => deals.moveStage(q, "d_job", "demo"));
    expect(await runs()).toEqual([]);
  });

  it("CANNOT LOOP: two rules undoing each other stop after one round", async () => {
    await moveRule("au_forward", "won", "delivery", 20);
    await moveRule("au_back", "delivery", "won", 10);
    const final = await inA((q) => deals.moveStage(q, "d_job", "won"));
    expect(final?.stage).toBe("won");
    expect((await runs()).map((r) => `${r.automation_id}:${r.outcome}`)).toEqual([
      "au_forward:skipped",
      "au_back:done",
      "au_forward:done",
    ]);
  });

  it("stops a long chain of different rules at its limit", async () => {
    await moveRule("r1", "discovery", "demo", 40);
    await moveRule("r2", "demo", "won", 30);
    await moveRule("r3", "won", "delivery", 20);
    await moveRule("r4", "delivery", "referral", 10);
    await db.seed(`UPDATE deals SET stage = 'prospect' WHERE id = 'd_job'`);
    const final = await inA((q) => deals.moveStage(q, "d_job", "discovery"));
    expect(final?.stage).toBe("delivery");
    expect((await runs()).find((r) => r.automation_id === "r4")?.outcome).toBe("skipped");
  });

  it("RUNS WHEN A PAYMENT WINS THE DEAL, which never passes through a stage move", async () => {
    await db.seed(`
      INSERT INTO automations (id, sub_account_id, event_kind, when_stage, action_kind, assignee_ids)
      VALUES ('au_won', '${TENANT_A}', 'deal_stage_changed', 'won', 'assign_owner', ARRAY['u_kim']::text[]);`);
    const first = await inA((q) => deals.recordPayment(q, "d_job", 400000));
    await inA((q) => deals.recordPayment(q, "d_job", 100000));

    const [won] = await read<{ owner_user_id: string }>(`SELECT owner_user_id FROM deals WHERE id = '${first.wonDealId}'`);
    expect(won.owner_user_id).toBe("u_kim");
    expect(await runs(), "a top-up counted as a second win").toHaveLength(1);
  });
});

describe("leads nobody wired up by hand", () => {
  it("ROUTES A WEBSITE ENQUIRY FROM THE PUBLIC FORM", async () => {
    await db.seed(`
      INSERT INTO booking_links (id, sub_account_id, slug, title, enabled, enquiries_enabled)
        VALUES ('bl_a', '${TENANT_A}', 'acme-cranes', 'Site visit', FALSE, TRUE);`);
    await assignRule("au_web", ["u_kim"], { source: "website" });

    const out = await enquiry.enquire({
      slug: "acme-cranes",
      name: "Amara Dube",
      email: "amara@heineken.test",
      phone: "",
      message: "We need a crane.",
      trap: "",
    });
    expect(out.ok).toBe(true);

    const [deal] = await read<{ owner_user_id: string }>(`SELECT owner_user_id FROM deals`);
    const [person] = await read<{ owner_user_id: string }>(`SELECT owner_user_id FROM contacts`);
    expect(deal.owner_user_id).toBe("u_kim");
    expect(person.owner_user_id, "the enquirer was left on the link owner's desk").toBe("u_kim");
  });
});
