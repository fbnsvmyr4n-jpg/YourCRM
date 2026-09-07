import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, AGENCY, TENANT_A, TENANT_B, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * A quotation an agent drafted.
 *
 * The feature has one safety property and it is the reason for most of this
 * file: **the AI drafts and revises, a named human approves, and only then does
 * anything leave for a client.** So the tests that matter are not the happy
 * path — they are the ones that try to get a price out of the building without
 * a person, and fail.
 *
 * The second property is that every figure comes off the price list. An AI
 * asked to quote a crane with no price list produces a number that looks like a
 * price and is not one, so the tool is driven here with an item nobody priced,
 * and with a fractional quantity — the exact input that once turned 3.5 days
 * into 4 on a purchase order and sent it out $7,250 high.
 *
 * The fixture is sized so every total below was worked out by hand first.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let quotes: typeof import("../src/server/repos/quotes");
let deals: typeof import("../src/server/repos/deals");
let runQuoteTool: typeof import("../src/server/quote-agent").runQuoteTool;
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string, userId = USER_A): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId,
  role: "owner",
});
const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

const JOB = "d_stellenbosch";
/** A colleague, for the two-people-approving test. The harness seeds only one. */
const USER_B = "u_test_b";
/** $12,000.00 a day, and $1,250.50 — the second has cents on purpose. */
const CRANE = 1_200_000;
const SURVEY = 125_050;

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  quotes = await import("../src/server/repos/quotes");
  deals = await import("../src/server/repos/deals");
  ({ runQuoteTool } = await import("../src/server/quote-agent"));
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM document_lines; DELETE FROM documents;
    DELETE FROM price_items;
    DELETE FROM deals; DELETE FROM contacts; DELETE FROM companies;

    INSERT INTO users (id, agency_id, sub_account_id, email, password_hash, name, role)
    VALUES ('${USER_B}', '${AGENCY}', '${TENANT_A}', 'b@test.local', 'x', 'Tester B', 'owner')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO companies (id, sub_account_id, name) VALUES
      ('co_heineken', '${TENANT_A}', 'Heineken');

    INSERT INTO contacts (id, sub_account_id, first_name, last_name, email, company_id) VALUES
      ('ct_procure', '${TENANT_A}', 'Amara', 'Dube', 'amara@heineken.test', 'co_heineken'),
      ('ct_noemail', '${TENANT_A}', 'Ben',   'Cole', NULL,                  'co_heineken');

    INSERT INTO deals (id, sub_account_id, company_id, contact_id, title, value_cents, stage)
    VALUES ('${JOB}', '${TENANT_A}', 'co_heineken', 'ct_procure',
            'Rebuild warehouse', 1800000_00, 'discovery');

    INSERT INTO price_items (id, sub_account_id, name, unit, unit_cents) VALUES
      ('pi_crane',  '${TENANT_A}', 'Mobile crane hire', 'per day', ${CRANE}),
      ('pi_survey', '${TENANT_A}', 'Site survey',       'each',    ${SURVEY});

    INSERT INTO price_items (id, sub_account_id, name, unit, unit_cents, active) VALUES
      ('pi_old', '${TENANT_A}', 'Scaffolding (withdrawn)', 'per day', 50000, FALSE);`)
);

/** Draft straight through the repository, bypassing the agent. */
const draft = (lines: { description: string; quantity: number; unitCents: number }[]) =>
  inA((q) =>
    quotes.draftQuote(q, {
      dealId: JOB,
      partyContactId: "ct_procure",
      party: "Amara Dube, Heineken",
      notes: null,
      lines,
      agent: "chat",
    })
  );

const oneCraneDay = [{ description: "Mobile crane hire", quantity: 1, unitCents: CRANE }];

describe("what a drafted quotation is", () => {
  it("lands waiting for approval, marked as the agent's work, at revision zero", async () => {
    const { quote } = await draft(oneCraneDay);
    expect(quote?.status).toBe("awaiting_approval");
    expect(quote?.draftedByAgent).toBe("chat");
    expect(quote?.revision).toBe(0);
    expect(quote?.approvedAt).toBeNull();
    expect(quote?.sentAt).toBeNull();
  });

  it("keeps a fractional quantity instead of rounding it up", async () => {
    // 3.5 days at $12,000 is $42,000. Rounded to 4 it is $48,000 — the mistake
    // that shipped once already, one table over.
    const { quote } = await draft([
      { description: "Mobile crane hire", quantity: 3.5, unitCents: CRANE },
    ]);
    expect(quote?.lines[0].quantity).toBe(3.5);
    expect(quote?.totalCents).toBe(4_200_000);
  });

  it("totals lines in exact cents", async () => {
    // 2 × $1,250.50 = $2,501.00, plus one crane day: $14,501.00.
    const { quote } = await draft([
      ...oneCraneDay,
      { description: "Site survey", quantity: 2, unitCents: SURVEY },
    ]);
    expect(quote?.totalCents).toBe(1_450_100);
  });

  it("refuses a quotation with no lines", async () => {
    const { error } = await draft([]);
    expect(error).toMatch(/at least one line/i);
  });

  it("belongs to its own workspace and no other", async () => {
    const { quote } = await draft(oneCraneDay);
    expect(await inB((q) => quotes.findQuote(q, quote!.id))).toBeNull();
    expect(await inB((q) => quotes.quotesNeedingUser(q))).toEqual([]);
  });
});

describe("nothing leaves without a person", () => {
  it("cannot be sent before it is approved", async () => {
    const { quote } = await draft(oneCraneDay);
    expect(await inA((q) => quotes.markQuoteSent(q, quote!.id))).toBe(false);

    const after = await inA((q) => quotes.findQuote(q, quote!.id));
    expect(after?.status).toBe("awaiting_approval");
    expect(after?.sentAt).toBeNull();
  });

  it("records WHO approved it, not merely that it was approved", async () => {
    const { quote } = await draft(oneCraneDay);
    const approved = await inA((q) => quotes.approveQuote(q, quote!.id));
    expect(approved.quote?.status).toBe("approved");
    expect(approved.quote?.approvedAt).not.toBeNull();

    const row = await inA((q) =>
      q.one<{ approved_by_user_id: string }>(
        `SELECT approved_by_user_id FROM documents WHERE id = $1`,
        [quote!.id]
      )
    );
    expect(row?.approved_by_user_id).toBe(USER_A);
  });

  it("only lets one of two people approve it", async () => {
    const { quote } = await draft(oneCraneDay);
    await withTenant(ctxFor(TENANT_A, USER_A), (q) => quotes.approveQuote(q, quote!.id));
    const second = await withTenant(ctxFor(TENANT_A, USER_B), (q) =>
      quotes.approveQuote(q, quote!.id)
    );
    expect(second.error).toMatch(/already been approved/i);

    // The first name is the one that stays. A second stamp overwriting it would
    // put the wrong person's name against the decision.
    const row = await inA((q) =>
      q.one<{ approved_by_user_id: string }>(
        `SELECT approved_by_user_id FROM documents WHERE id = $1`,
        [quote!.id]
      )
    );
    expect(row?.approved_by_user_id).toBe(USER_A);
  });

  it("goes out only after approval, and stamps when", async () => {
    const { quote } = await draft(oneCraneDay);
    await inA((q) => quotes.approveQuote(q, quote!.id));
    expect(await inA((q) => quotes.markQuoteSent(q, quote!.id))).toBe(true);

    const sent = await inA((q) => quotes.findQuote(q, quote!.id));
    expect(sent?.status).toBe("sent");
    expect(sent?.sentAt).not.toBeNull();
  });

  it("stays on the list after approval until it has actually gone", async () => {
    // Approval and despatch are two facts. A quote approved but not emailed —
    // no address, or the mail service down — must keep asking for attention.
    const { quote } = await draft(oneCraneDay);
    await inA((q) => quotes.approveQuote(q, quote!.id));
    const waiting = await inA((q) => quotes.quotesNeedingUser(q));
    expect(waiting.map((w) => w.id)).toEqual([quote!.id]);

    await inA((q) => quotes.markQuoteSent(q, quote!.id));
    expect(await inA((q) => quotes.quotesNeedingUser(q))).toEqual([]);
  });
});

describe("revising", () => {
  it("replaces the lines and counts the revision", async () => {
    const { quote } = await draft(oneCraneDay);
    const { quote: revised } = await inA((q) =>
      quotes.reviseQuote(q, {
        documentId: quote!.id,
        lines: [{ description: "Mobile crane hire", quantity: 2, unitCents: CRANE }],
      })
    );
    expect(revised?.revision).toBe(1);
    expect(revised?.lines).toHaveLength(1);
    expect(revised?.totalCents).toBe(2_400_000);
    expect(revised?.status).toBe("awaiting_approval");
  });

  it("refuses to alter a quotation somebody has already approved", async () => {
    const { quote } = await draft(oneCraneDay);
    await inA((q) => quotes.approveQuote(q, quote!.id));
    const { error } = await inA((q) =>
      quotes.reviseQuote(q, {
        documentId: quote!.id,
        lines: [{ description: "Site survey", quantity: 1, unitCents: SURVEY }],
      })
    );
    expect(error).toMatch(/can no longer be changed/i);
  });
});

describe("discarding", () => {
  it("takes a draft off the list without erasing that it happened", async () => {
    const { quote } = await draft(oneCraneDay);
    expect(await inA((q) => quotes.discardQuote(q, quote!.id))).toBe(true);
    expect(await inA((q) => quotes.quotesNeedingUser(q))).toEqual([]);

    const row = await inA((q) =>
      q.one<{ deleted_at: Date | null }>(`SELECT deleted_at FROM documents WHERE id = $1`, [
        quote!.id,
      ])
    );
    expect(row?.deleted_at).not.toBeNull();
  });

  it("will not discard one that has already gone to the client", async () => {
    const { quote } = await draft(oneCraneDay);
    await inA((q) => quotes.approveQuote(q, quote!.id));
    await inA((q) => quotes.markQuoteSent(q, quote!.id));
    expect(await inA((q) => quotes.discardQuote(q, quote!.id))).toBe(false);
  });
});

describe("numbering", () => {
  it("starts somewhere when there is nothing to continue", async () => {
    expect(await inA((q) => quotes.nextQuoteNumber(q))).toBe("Q-1001");
  });

  it("continues the numbering the business already uses, padding and all", async () => {
    await db.seed(`
      INSERT INTO documents (id, sub_account_id, deal_id, kind, number, status)
      VALUES ('q_seed', '${TENANT_A}', '${JOB}', 'quote', '2026/007', 'sent');`);
    expect(await inA((q) => quotes.nextQuoteNumber(q))).toBe("2026/008");
  });

  it("gives consecutive drafts different numbers", async () => {
    const first = await draft(oneCraneDay);
    const second = await draft(oneCraneDay);
    expect(first.quote?.number).toBe("Q-1001");
    expect(second.quote?.number).toBe("Q-1002");
  });
});

/* ------------------------------------------------------------------ */
/* The agent's own hands                                               */
/*                                                                     */
/* Driven exactly as the model drives it: a name it read in the prompt */
/* and a number it typed. Every one of these inputs is generated text. */
/* ------------------------------------------------------------------ */

const tool = (name: string, input: unknown) => inA((q) => runQuoteTool(q, name, input, "chat"));

describe("what the agent can and cannot do", () => {
  it("drafts from the price list, pricing each line from the stored rate", async () => {
    const { quote, text } = await tool("draft_quotation", {
      project: "Rebuild warehouse",
      lines: [
        { item: "Mobile crane hire", quantity: 3.5 },
        { item: "Site survey", quantity: 2, note: "north elevation" },
      ],
    });

    // 3.5 × $12,000 + 2 × $1,250.50 = $42,000 + $2,501 = $44,501.
    expect(quote?.totalCents).toBe(4_450_100);
    expect(quote?.status).toBe("awaiting_approval");
    expect(quote?.lines[1].description).toBe("Site survey — north elevation");
    // The model is told what happens next, in the words the user will see.
    expect(text).toMatch(/waiting for the user's approval/i);
    expect(text).toMatch(/amara@heineken\.test/);
  });

  it("starts a project for a client who has none, so quoting need not leave the chat", async () => {
    /*
       The three-screen errand this removes: a quotation has always required a
       project, and nothing in chat could make one — so a new enquiry meant
       leaving the conversation, opening Deals, adding one, opening it, and
       coming back. The voice agent has never had that problem; `log_enquiry`
       creates the job as part of the call. This is the same move.
    */
    const { text } = await tool("start_project", {
      client: "Amara Dube",
      title: "New loading bay",
    });
    expect(text).toMatch(/Started "New loading bay"/);

    const started = (await inA((q) => deals.listDeals(q))).find((d) => d.title === "New loading bay");
    expect(started?.stage).toBe("prospect");
    expect(started?.contactId).toBe("ct_procure");
    /* The company follows the contact, which is what puts the new job on the
       Projects page under the right client. */
    expect(started?.companyId).toBe("co_heineken");

    // And it is immediately quotable, which is the entire point.
    const { quote } = await tool("draft_quotation", {
      project: "New loading bay",
      lines: [{ item: "Site survey", quantity: 1 }],
    });
    expect(quote?.totalCents).toBe(125_050);
  });

  it("never invents a budget for a project it starts", async () => {
    /* The value on a deal drives the pipeline and the forecast. A number the
       agent estimated would read there exactly like one somebody was told. */
    await tool("start_project", { client: "Amara Dube", title: "No budget given" });
    const started = (await inA((q) => deals.listDeals(q))).find((d) => d.title === "No budget given");
    expect(started?.valueCents).toBe(0);

    await tool("start_project", { client: "Amara Dube", title: "Budget stated", valueHint: 25000 });
    const withBudget = (await inA((q) => deals.listDeals(q))).find((d) => d.title === "Budget stated");
    expect(withBudget?.valueCents).toBe(2_500_000);
  });

  it("refuses to start a project for somebody who is not a contact", async () => {
    /* Adding a person from a half-remembered name is how duplicate records
       start, and the agent cannot check an email or a number. */
    const before = (await inA((q) => deals.listDeals(q))).length;
    const { text } = await tool("start_project", { client: "Someone Nobody Knows", title: "A job" });
    expect(text).toMatch(/Add them to Contacts first/);
    expect((await inA((q) => deals.listDeals(q))).length, "a project was created anyway").toBe(before);
  });

  it("QUOTES A JOB THAT IS ALREADY BEING DELIVERED", async () => {
    /*
       The defect this replaced. The agent filtered on `wonAt === null`, and
       `won_at` is stamped at the close and deliberately preserved through
       Delivery and Referral — so a job somebody was on site delivering
       vanished from the agent's list at exactly the moment a variation is
       most likely to be asked for. Meanwhile the Projects page counted the
       same job as live: two screens, two definitions of "the current jobs".
    */
    for (const stage of ["won", "delivery"] as const) {
      await db.seed(`UPDATE deals SET stage = '${stage}', won_at = now() WHERE id = '${JOB}'`);
      const { quote, text } = await tool("draft_quotation", {
        project: "Rebuild warehouse",
        lines: [{ item: "Site survey", quantity: 1 }],
      });
      expect(quote, `a job in ${stage} could not be quoted: ${text}`).toBeTruthy();
      await db.seed(`DELETE FROM document_lines; DELETE FROM documents;`);
    }
  });

  it("leaves finished and lost work out of it", async () => {
    /* `referral` and `lost` are terminal — the same line the Projects page
       draws. Offering to quote a job that is over is a different kind of
       wrong from hiding one that is running. */
    for (const stage of ["referral", "lost"] as const) {
      await db.seed(`UPDATE deals SET stage = '${stage}' WHERE id = '${JOB}'`);
      const { quote, text } = await tool("draft_quotation", {
        project: "Rebuild warehouse",
        lines: [{ item: "Site survey", quantity: 1 }],
      });
      expect(quote, `a ${stage} job was quotable`).toBeUndefined();
      expect(text).toMatch(/Current projects are/);
    }
  });

  it("refuses an item nobody has priced, and writes nothing", async () => {
    const { quote, text } = await tool("draft_quotation", {
      project: "Rebuild warehouse",
      lines: [{ item: "Helicopter lift", quantity: 1 }],
    });
    expect(quote).toBeUndefined();
    expect(text).toMatch(/nothing matches/i);
    // It is told what IS on the list, so it can offer the real thing.
    expect(text).toMatch(/Mobile crane hire/);
    expect(await inA((q) => quotes.quotesNeedingUser(q))).toEqual([]);
  });

  it("will not quote a withdrawn rate", async () => {
    const { quote, text } = await tool("draft_quotation", {
      project: "Rebuild warehouse",
      lines: [{ item: "Scaffolding (withdrawn)", quantity: 1 }],
    });
    expect(quote).toBeUndefined();
    expect(text).toMatch(/nothing matches/i);
  });

  it("refuses a project it cannot pin down rather than guessing one", async () => {
    const { quote, text } = await tool("draft_quotation", {
      project: "the Cape Town job",
      lines: [{ item: "Site survey" }],
    });
    expect(quote).toBeUndefined();
    expect(text).toMatch(/nothing matches/i);
  });

  it("treats a missing quantity as one, and a nonsense quantity as a refusal", async () => {
    const one = await tool("draft_quotation", {
      project: "Rebuild warehouse",
      lines: [{ item: "Site survey" }],
    });
    expect(one.quote?.lines[0].quantity).toBe(1);
    expect(one.quote?.totalCents).toBe(SURVEY);

    const bad = await tool("draft_quotation", {
      project: "Rebuild warehouse",
      lines: [{ item: "Site survey", quantity: "quite a few" }],
    });
    expect(bad.quote).toBeUndefined();
    expect(bad.text).toMatch(/could not be read as a number/i);
  });

  it("addresses it to the person asked for, and says when they have no email", async () => {
    const { quote, text } = await tool("draft_quotation", {
      project: "Rebuild warehouse",
      recipient: "Ben Cole",
      lines: [{ item: "Site survey" }],
    });
    expect(quote?.party).toBe("Ben Cole, Heineken");
    expect(quote?.partyEmail).toBeNull();
    expect(text).toMatch(/no email address on file/i);
  });

  it("revises the quotation the user named, by its number", async () => {
    const drafted = await tool("draft_quotation", {
      project: "Rebuild warehouse",
      lines: [{ item: "Mobile crane hire", quantity: 3 }],
    });

    const revised = await tool("revise_quotation", {
      quotation: drafted.quote!.number,
      lines: [{ item: "Mobile crane hire", quantity: 2 }],
    });
    expect(revised.quote?.revision).toBe(1);
    expect(revised.quote?.totalCents).toBe(2_400_000);
    expect(revised.text).toMatch(/revision 1/i);
  });

  it("has no tool for sending, and says so when asked for one", async () => {
    // The safety property as the model would meet it: there is no vocabulary
    // for despatch in the tools it was handed.
    const { text } = await tool("send_quotation", { quotation: "Q-1001" });
    expect(text).toMatch(/no tool called/i);
  });
});
