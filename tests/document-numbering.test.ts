import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, TENANT_A } from "./helpers/pg";

/**
 * A document number somebody already used.
 *
 * Numbers are unique per kind per workspace, enforced by an index — which means
 * the database REFUSES the insert, and a refused statement leaves a Postgres
 * transaction aborted. Catching that error without a savepoint turns a polite
 * "that number is taken" into every later statement answering "current
 * transaction is aborted, commands ignored".
 *
 * Two places caught it that way. The AI quote drafter is the one that hurt: on a
 * call, the gateway writes its audit row in the same transaction right after
 * the tool returns, so a taken number crashed the tool call instead of being
 * recorded as a refusal. And because the drafter only looks at the 25 most
 * recent quotations when choosing a number, an older quote holding the next
 * number made that happen EVERY time, not only in a race.
 *
 * Each test below finishes with one more statement in the same transaction.
 * That statement is the whole point: it is what fails when the savepoint is
 * missing.
 */

/* The Documents form is a server action behind a session. Signed in as the
   harness owner, and — the part that matters — with one extra statement run on
   the SAME querier after the action body returns, standing in for whatever
   anybody adds after that catch later. */
vi.mock("@/server/tenant-session", () => ({
  requireTenant: async () => {
    const pg = await import("./helpers/pg");
    return { agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role: "owner" };
  },
  withCurrentTenant: async <T,>(fn: (q: unknown) => Promise<T>) => {
    const pg = await import("./helpers/pg");
    const { withTenant } = await import("../src/server/tenant");
    const ctx = { agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role: "owner" as const };
    return withTenant(ctx, async (q) => {
      const out = await fn(q);
      await q.one(`SELECT 1 AS still_usable`);
      return out;
    });
  },
}));
vi.mock("@/server/revalidate", () => ({ revalidateApp: () => {} }));

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let quotes: typeof import("../src/server/repos/quotes");
let createDocumentAction: typeof import("../src/app/(app)/projects/actions").createDocumentAction;
let closePool: typeof import("../src/server/db").closePool;
let AGENCY: string;
let USER_A: string;

const JOB = "d_numbering";

beforeAll(async () => {
  db = await startTestDb();
  ({ AGENCY, USER_A } = await import("./helpers/pg"));
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  quotes = await import("../src/server/repos/quotes");
  ({ createDocumentAction } = await import("../src/app/(app)/projects/actions"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM document_lines; DELETE FROM documents;
    DELETE FROM deals; DELETE FROM contacts; DELETE FROM companies;
    INSERT INTO companies (id, sub_account_id, name) VALUES ('co_n', '${TENANT_A}', 'Heineken');
    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, company_id)
      VALUES ('ct_n', '${TENANT_A}', 'Amara', 'Dube', 'amara@heineken.test', 'co_n');
    INSERT INTO deals (id, sub_account_id, company_id, contact_id, title, value_cents, stage)
      VALUES ('${JOB}', '${TENANT_A}', 'co_n', 'ct_n', 'Rebuild warehouse', 1800000_00, 'discovery');
  `)
);

/** A quotation numbered `number`, created `daysAgo` days ago. */
const oldQuote = (id: string, number: string, daysAgo: number) =>
  `INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status, created_at)
   VALUES ('${id}', '${TENANT_A}', '${JOB}', 'quote', '${number}', 'sent', now() - interval '${daysAgo} days');`;

/**
 * Twenty-five recent quotations, the newest numbered Q-1041, so the drafter's
 * next-number guess is Q-1042 — and it cannot see anything older than these.
 */
const recentQuotes = () =>
  Array.from({ length: 24 }, (_, i) =>
    oldQuote(`q_recent_${i}`, `OTHER-${String(i + 1).padStart(4, "0")}`, 2 + i / 100)
  ).join("\n") + oldQuote("q_newest", "Q-1041", 1);

const drafted = () =>
  withTenant({ agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" }, async (q) => {
    const result = await quotes.draftQuote(q, {
      dealId: JOB,
      partyContactId: "ct_n",
      party: "Amara Dube, Heineken",
      notes: null,
      lines: [{ description: "Mobile crane hire", quantity: 1, unitCents: 1_200_000 }],
      agent: "voice",
    });
    // The statement that fails when the savepoint is missing.
    const probe = await q.one<{ still_usable: number }>(`SELECT 1 AS still_usable`);
    return { result, probe };
  });

describe("the AI quote drafter", () => {
  it("guesses the number the way it always has", () => {
    expect(quotes.followingNumber("Q-1041")).toBe("Q-1042");
    expect(quotes.followingNumber("2026/007")).toBe("2026/008");
    expect(quotes.followingNumber("Q-0999")).toBe("Q-1000");
    expect(quotes.followingNumber("ESTIMATE")).toBeNull();
  });

  it("MOVES ON TO A FREE NUMBER WHEN AN OLDER QUOTE ALREADY HOLDS THE ONE IT GUESSED", async () => {
    /* Q-1042 exists but is older than the 25 quotations the guess looks at.
       Before this fix the draft failed — and failed identically on every
       retry, because every retry guessed Q-1042 again. */
    await db.seed(oldQuote("q_ancient", "Q-1042", 400) + recentQuotes());

    const { result, probe } = await drafted();
    expect(result.error, "the draft was refused").toBeUndefined();
    expect(result.quote?.number).toBe("Q-1043");
    expect(probe?.still_usable, "the transaction was left aborted").toBe(1);
  });

  it("gives up after a short run of taken numbers, names the range it tried, and writes nothing", async () => {
    /*
       Driven with a stand-in querier that refuses every number, NOT through the
       database. That is a harness limit, established rather than assumed: two
       or more PARAMETERISED statements failing back to back inside savepoints
       desync the PGlite socket server this suite runs on — the follow-up
       `SELECT 1` comes back empty and the connection dies. The same sequence is
       fine with literal SQL, fine on PGlite in-process, and fine on real
       Postgres 16. The test above already proves a refused number leaves the
       transaction usable, through the real database; this one proves the
       bound, the message and that nothing is written after giving up.
    */
    const statements: string[] = [];
    let attempts = 0;
    const refusing = {
      ctx: { agencyId: AGENCY, subAccountId: TENANT_A, userId: USER_A, role: "owner" },
      one: async (sql: string) => {
        statements.push(sql);
        /* A workspace that has never saved settings: drafting reads them for
           the business's own date, and gets the defaults. */
        if (/FROM settings/.test(sql)) return null;
        return { id: JOB };
      },
      rows: async (sql: string) => {
        statements.push(sql);
        return /SELECT number FROM documents/.test(sql) ? [{ number: "Q-1041" }] : [];
      },
      attempt: async () => {
        attempts++;
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "documents_number_once"'),
          { code: "23505" }
        );
      },
    } as unknown as Parameters<typeof quotes.draftQuote>[0];

    const result = await quotes.draftQuote(refusing, {
      dealId: JOB,
      partyContactId: null,
      party: null,
      notes: null,
      lines: [{ description: "Mobile crane hire", quantity: 1, unitCents: 1_200_000 }],
      agent: "voice",
    });

    expect(attempts, "it did not stop at the bound").toBe(5);
    expect(result.quote).toBeUndefined();
    expect(result.error).toMatch(/Q-1042 to Q-1046 are already taken/);
    expect(
      statements.some((s) => /document_lines/.test(s)),
      "lines were written for a quotation that was never saved"
    ).toBe(false);
  });
});

describe("the Documents form on a project", () => {
  const form = (number: string) => {
    const f = new FormData();
    f.set("dealId", JOB);
    f.set("kind", "purchase_order");
    f.set("number", number);
    f.append("lineDescription", "Steel");
    f.append("lineQuantity", "1");
    f.append("lineUnit", "100");
    return f;
  };

  it("SAYS THE NUMBER IS TAKEN, AND THE TRANSACTION IT RAN IN STILL WORKS", async () => {
    await db.seed(
      `INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status)
       VALUES ('po_existing', '${TENANT_A}', '${JOB}', 'purchase_order', 'PO-7', 'sent');`
    );

    // Lowercase on purpose: the index compares lower(number).
    const out = await createDocumentAction(undefined, form("po-7"));
    expect(out).toEqual({ error: "You already have a document numbered po-7." });
  });

  it("still saves a number nobody has used", async () => {
    const out = await createDocumentAction(undefined, form("PO-8"));
    expect(out?.ok).toMatch(/PO-8 saved with 1 line/);
  });
});
