/*
   The home pages for finance and IT.

   Until 20 Oct 2026 neither role had one. `/` was the sales dashboard — every
   figure on it customer work their tiers correctly keep from them — so both
   were sent to Settings, and their first screen on signing in was their own
   profile.

   Each home answers one question:

     Finance — who owes us, and who do I chase today?
     IT      — is anything broken, and who changed what?

   What this file protects, most of all: the figures are the SAME figures the
   screens they summarise show, because they are made by the same functions. A
   home page that totalled things its own way would be a second answer, and
   the day the two disagreed nobody would know which to believe.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

const read = (p: string) =>
  readFileSync(`${process.cwd()}/${p}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let withSystem: typeof import("../src/server/tenant").withSystem;
let home: typeof import("../src/server/role-home");
let ledger: typeof import("../src/server/document-ledger");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

const TZ = "Africa/Johannesburg";
const TODAY = "2026-10-20";

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant, withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  home = await import("../src/server/role-home");
  ledger = await import("../src/server/document-ledger");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const finance = (opts: { mayReadMail?: boolean } = {}) =>
  inA((q) => home.financeHome(q, { today: TODAY, timeZone: TZ, mayReadMail: opts.mayReadMail ?? true }));

/*
   SIX INVOICES, each a case that has to be told apart:

     INV-1  sent, due 40 days ago, unpaid            → chase, most late
     INV-2  sent, due 5 days ago, R4,000 of R10,000 paid → chase the R6,000 left
     INV-3  sent, due in the future                 → owed, NOT overdue
     INV-4  sent, NO due date                       → owed, never "late"
     INV-5  draft                                   → owes nothing yet
     INV-6  cancelled, past due                     → owes nothing at all

   Plus another workspace's overdue invoice, which must never appear.
*/
beforeEach(() =>
  db.seed(`
    DELETE FROM invoice_payments; DELETE FROM document_lines; DELETE FROM documents;
    DELETE FROM deals; DELETE FROM contacts; DELETE FROM outbox;
    -- audit_events is append-only and refuses a DELETE, by design; only one
    -- test below writes to it.
    DELETE FROM login_attempts;
    DELETE FROM users WHERE id <> '${USER_A}';
    DELETE FROM agencies WHERE id = 'ag_other';
    INSERT INTO settings (sub_account_id, currency, vat_rate_bp, prices_include_vat, time_zone)
      VALUES ('${TENANT_A}', 'ZAR', 0, FALSE, '${TZ}')
      ON CONFLICT (sub_account_id) DO UPDATE SET
        currency = 'ZAR', vat_rate_bp = 0, prices_include_vat = FALSE, time_zone = '${TZ}';
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email) VALUES
      ('ct_ben', '${TENANT_A}', 'Ben', 'Cole', 'ben@cole.test');
    INSERT INTO deals (id, sub_account_id, title, stage, contact_id) VALUES
      ('d1', '${TENANT_A}', 'Paving', 'won', 'ct_ben'),
      ('d9', '${TENANT_B}', 'Theirs', 'won', NULL);
    INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, party, party_contact_id, due_on) VALUES
      ('i1', '${TENANT_A}', 'd1', 'invoice', 'INV-1', 'sent',      'Ben Cole', 'ct_ben', '2026-09-10'),
      ('i2', '${TENANT_A}', 'd1', 'invoice', 'INV-2', 'sent',      'Ben Cole', 'ct_ben', '2026-10-15'),
      ('i3', '${TENANT_A}', 'd1', 'invoice', 'INV-3', 'sent',      'Ben Cole', 'ct_ben', '2026-11-30'),
      ('i4', '${TENANT_A}', 'd1', 'invoice', 'INV-4', 'sent',      'Ben Cole', 'ct_ben', NULL),
      ('i5', '${TENANT_A}', 'd1', 'invoice', 'INV-5', 'draft',     'Ben Cole', 'ct_ben', '2026-09-01'),
      ('i6', '${TENANT_A}', 'd1', 'invoice', 'INV-6', 'cancelled', 'Ben Cole', 'ct_ben', '2026-09-01'),
      ('i9', '${TENANT_B}', 'd9', 'invoice', 'INV-9', 'sent',      'Someone',  NULL,     '2026-09-01');
    INSERT INTO document_lines (id, sub_account_id, document_id, description, quantity, unit_cents, position) VALUES
      ('l1', '${TENANT_A}', 'i1', 'Work', 1, 500000, 0),
      ('l2', '${TENANT_A}', 'i2', 'Work', 1, 1000000, 0),
      ('l3', '${TENANT_A}', 'i3', 'Work', 1, 200000, 0),
      ('l4', '${TENANT_A}', 'i4', 'Work', 1, 300000, 0),
      ('l5', '${TENANT_A}', 'i5', 'Work', 1, 2247000, 0),
      ('l6', '${TENANT_A}', 'i6', 'Work', 1, 900000, 0),
      ('l9', '${TENANT_B}', 'i9', 'Work', 1, 7700000, 0);
    INSERT INTO invoice_payments (id, sub_account_id, document_id, provider, reference, amount_cents, currency, channel, paid_at) VALUES
      ('p_now',  '${TENANT_A}', 'i2', 'manual', 'r1', 400000, 'ZAR', 'transfer',
        (date_trunc('month', now() AT TIME ZONE '${TZ}') + interval '2 hours') AT TIME ZONE '${TZ}'),
      ('p_last', '${TENANT_A}', 'i2', 'manual', 'r2', 0 + 1, 'ZAR', 'cash',
        (date_trunc('month', now() AT TIME ZONE '${TZ}') - interval '10 days') AT TIME ZONE '${TZ}');
  `)
);

describe("the finance home's figures", () => {
  it("OUTSTANDING IS THE INVOICES SCREEN'S OWN FIGURE", async () => {
    /* Not a second sum. If the home and the Invoices page ever disagreed about
       what is owed, nobody could tell which to believe. */
    const h = await finance();
    const inv = await inA((q) => ledger.documentLedger(q, "invoice"));
    expect(h.outstandingCents).toBe(inv.notCountedCents);
  });

  it("DOES NOT COUNT A DRAFT — the client has never been sent it", async () => {
    /*
       The bug found while building this page: the Invoices screen's
       Outstanding figure counted drafts, and on the dev workspace the whole
       R25,840.50 was one unsent invoice. Owed here: INV-1 R5,000 + INV-2's
       remaining R6,000 (less the R0.01 cash) + INV-3 R2,000 + INV-4 R3,000.
       Not INV-5 (draft), not INV-6 (cancelled).
    */
    const h = await finance();
    expect(h.outstandingCents).toBe(500000 + (1000000 - 400000 - 1) + 200000 + 300000);
    expect(h.outstandingCount).toBe(4);
  });

  it("shows drafts SEPARATELY, as work waiting to go out", async () => {
    const h = await finance();
    expect(h.draftInvoices).toEqual({ count: 1, cents: 2247000 });
  });
});

describe("who to chase", () => {
  it("IS EVERY INVOICE PAST ITS DUE DATE WITH MONEY STILL OWED — most late first", async () => {
    const h = await finance();
    expect(h.chase.map((c) => c.number)).toEqual(["INV-1", "INV-2"]);
    expect(h.chase[0]).toMatchObject({ daysLate: 40, owedCents: 500000, dueOn: "2026-09-10" });
  });

  it("chases what is LEFT on a part-paid invoice, not its total", async () => {
    const h = await finance();
    expect(h.chase.find((c) => c.number === "INV-2")?.owedCents).toBe(1000000 - 400000 - 1);
  });

  it("never calls an invoice late that has no due date", async () => {
    /* It is owed and it is on Outstanding — but "late" would be inventing a
       deadline nobody set. */
    const h = await finance();
    expect(h.chase.some((c) => c.number === "INV-4")).toBe(false);
  });

  it("never chases a draft or a cancelled invoice, however old", async () => {
    const h = await finance();
    expect(h.chase.map((c) => c.number)).not.toContain("INV-5");
    expect(h.chase.map((c) => c.number)).not.toContain("INV-6");
  });

  it("totals the overdue figure from the very rows it lists", async () => {
    const h = await finance();
    expect(h.overdueCents).toBe(h.chase.reduce((s, c) => s + c.owedCents, 0));
  });

  it("carries the address a chase would go to", async () => {
    /* The ledger's precedence: the document's own address, else the contact's. */
    const h = await finance();
    expect(h.chase[0].email).toBe("ben@cole.test");
  });

  it("drops an invoice from the list the moment it is covered", async () => {
    await inA((q) =>
      q.rows(
        `INSERT INTO invoice_payments (id, sub_account_id, document_id, provider, reference, amount_cents, currency, channel, paid_at)
         VALUES ('p_full', $1, 'i1', 'manual', 'r3', 500000, 'ZAR', 'transfer', now())`,
        [TENANT_A]
      )
    );
    const h = await finance();
    expect(h.chase.map((c) => c.number)).toEqual(["INV-2"]);
  });

  it("NEVER SHOWS ANOTHER WORKSPACE'S DEBTORS", async () => {
    const h = await finance();
    expect(h.chase.some((c) => c.number === "INV-9")).toBe(false);
    expect(h.outstandingCents).not.toBeGreaterThan(2000000);
  });
});

describe("money received", () => {
  it("SPLITS BY MONTH IN THE BUSINESS'S ZONE", async () => {
    /* At 01:00 on the 1st in Johannesburg the server is still in last month,
       and a payment landing at midnight would be counted in the wrong one. */
    const h = await finance();
    expect(h.receivedThisMonthCents).toBe(400000);
    expect(h.receivedLastMonthCents).toBe(1);
  });

  it("lists recent payments newest first, saying how each came in", async () => {
    const h = await finance();
    expect(h.recent.map((p) => [p.number, p.method])).toEqual([
      ["INV-2", "Transfer"],
      ["INV-2", "Cash"],
    ]);
  });
});

describe("mail on the finance home", () => {
  it("is not counted for a reader who may not open the inbox", async () => {
    /* Null, not zero: "0 unread" to somebody with no inbox is a row about a
       place they cannot go. */
    expect((await finance({ mayReadMail: false })).unread).toBeNull();
    expect(typeof (await finance({ mayReadMail: true })).unread).toBe("number");
  });
});

describe("the IT home", () => {
  it("COUNTS ONLY DELIVERIES STILL BROKEN — a discarded one is a decision, not a fault", async () => {
    await db.seed(`
      INSERT INTO outbox (id, sub_account_id, handler, status, attempts, last_error, settled_at) VALUES
        ('ob1', '${TENANT_A}', 'quote_email', 'dead', 8, 'Domain not verified', now()),
        ('ob2', '${TENANT_A}', 'quote_email', 'dead', 8, 'Domain not verified', now()),
        ('ob3', '${TENANT_A}', 'quote_email', 'pending', 0, NULL, NULL),
        ('ob9', '${TENANT_B}', 'quote_email', 'dead', 8, 'x', now());
      UPDATE outbox SET discarded_at = now() WHERE id = 'ob2';
    `);
    const t = await inA((q) => home.itHomeTenant(q));
    expect(t.failedDeliveries).toBe(1);
    expect(t.waitingToSend).toBe(1);
  });

  it("SHOWS ACCOUNT CHANGES, NOT SALES ACTIVITY", async () => {
    /* The audit log records every write, including "somebody changed a
       contact". That is most of the log and none of IT's business; unfiltered,
       the one role change that mattered would be buried in it. */
    await db.seed(`
      INSERT INTO audit_events (sub_account_id, actor_name, action, entity, entity_id, detail) VALUES
        ('${TENANT_A}', 'Tester A', 'update', 'contact',     'ct_ben', NULL),
        ('${TENANT_A}', 'Tester A', 'update', 'team_member', 'u_x',    'Role → finance'),
        ('${TENANT_A}', 'Tester A', 'update', 'deal',        'd1',     NULL),
        ('${TENANT_B}', 'Them',     'update', 'team_member', 'u_y',    'Role → owner');
    `);
    const t = await inA((q) => home.itHomeTenant(q));
    expect(t.changes.map((c) => c.what)).toEqual(["changed a team member — Role → finance"]);
    expect(t.changes[0].who).toBe("Tester A");
  });

  it("states every service as a fact with what it means", async () => {
    const t = await inA((q) => home.itHomeTenant(q));
    expect(t.services.map((s) => s.name)).toEqual(["Email", "Card payments", "AI assistant", "Phone calls"]);
    for (const s of t.services) expect(s.says.length).toBeGreaterThan(10);
  });
});

describe("who is locked out", () => {
  const seedPeople = () =>
    db.seed(`
      INSERT INTO agencies (id, name) VALUES ('ag_other', 'Other');
      INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role) VALUES
        ('u_ama',  '${AGENCY}',  '${TENANT_A}', 'ama@test.local',  'x', 'Ama Dube',   'finance'),
        ('u_kobi', '${AGENCY}',  '${TENANT_A}', 'kobi@test.local', 'x', 'Kobi Steyn', 'member'),
        ('u_out',  'ag_other',   NULL,          'out@other.test',  'x', 'Outsider',   'owner');
      INSERT INTO login_attempts (key, failures, locked_until) VALUES
        ('email:ama@test.local',  5, now() + interval '9 minutes'),
        ('email:kobi@test.local', 5, now() - interval '1 minute'),
        ('email:out@other.test',  5, now() + interval '9 minutes'),
        ('ip:10.0.0.1',           9, now() + interval '9 minutes');
    `);

  it("NAMES A COLLEAGUE LOCKED OUT RIGHT NOW, and nobody whose lock has cleared", async () => {
    await seedPeople();
    const a = await withSystem((q) => home.itHomeAgency(q, AGENCY));
    expect(a.lockedOut.map((l) => l.name)).toEqual(["Ama Dube"]);
  });

  it("NEVER NAMES ANOTHER BUSINESS'S STAFF", async () => {
    await seedPeople();
    const a = await withSystem((q) => home.itHomeAgency(q, AGENCY));
    expect(a.lockedOut.map((l) => l.name)).not.toContain("Outsider");
    expect(a.team.total).toBe(3);
  });

  it("never pins an IP lock on a person", async () => {
    /* Somebody else on their network guessing badly is not them, and naming
       them for it would be a false accusation. */
    await seedPeople();
    const a = await withSystem((q) => home.itHomeAgency(q, AGENCY));
    expect(a.lockedOut).toHaveLength(1);
  });

  it("counts the team by role", async () => {
    await seedPeople();
    const a = await withSystem((q) => home.itHomeAgency(q, AGENCY));
    expect(a.team.byRole).toEqual([
      { role: "owner", count: 1 },
      { role: "finance", count: 1 },
      { role: "member", count: 1 },
    ]);
  });
});

describe("which home a reader gets", () => {
  const page = read("src/app/(app)/page.tsx");

  it("IS DECIDED BEFORE ANY CUSTOMER DATA IS READ", () => {
    /* The branch comes first in the page, so a bookkeeper never reaches the
       sales dashboard's queries — which their door would refuse anyway. */
    const branch = page.indexOf("if (me && !canAccessCrm(me.role))");
    const crmLoad = page.indexOf("await listContacts(q)");
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(crmLoad);
  });

  it("opens each home through ITS OWN door, never the customer one", () => {
    expect(page).toMatch(/financeHome\([\s\S]*?\{ money: true \}/);
    expect(page).toMatch(/itHomeTenant\(q\)[\s\S]*?\{ ops: true \}/);
  });

  it("falls back to Settings for a role it does not recognise, so it cannot loop", () => {
    /* A screen a reader may not open sends them to `/`. If `/` then sent an
       unknown role anywhere that also refused them, the two would bounce
       forever. Settings opts out of every door. */
    expect(page).toMatch(/redirect\("\/settings"\);\s*\}\s*function greeting/);
    expect(read("src/server/tenant-session.ts")).toMatch(/!mayOpen\) \{\s*redirect\("\/"\);/);
  });

  it("does not nest the system query inside the tenant one", () => {
    /* The dev database serves one session at a time; a system query opened
       inside a tenant one waits for itself. */
    const it = page.slice(page.indexOf("if (canAccessOps(user.role))"));
    const tenantEnd = it.indexOf("{ ops: true }");
    const system = it.indexOf("withSystem(");
    expect(system).toBeGreaterThan(tenantEnd);
  });
});
