import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb, TENANT_A } from "./helpers/pg";

/** Retainers through the project screen's forms: what is refused, and what one press does. */

vi.mock("@/server/tenant-session", () => {
  const run = async <T,>(fn: (q: unknown) => Promise<T>) => {
    const pg = await import("./helpers/pg");
    const { withTenant } = await import("../src/server/tenant");
    return withTenant({ agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role: "member" }, (q) => fn(q));
  };
  return {
    withCurrentTenant: run,
    requireTenant: async () => {
      const pg = await import("./helpers/pg");
      return { agencyId: pg.AGENCY, subAccountId: pg.TENANT_A, userId: pg.USER_A, role: "member" };
    },
  };
});
vi.mock("@/server/revalidate", () => ({ revalidateApp: () => {} }));

let db: TestDb;
let actions: typeof import("../src/app/(app)/projects/actions");
let withSystem: typeof import("../src/server/tenant").withSystem;
let closePool: typeof import("../src/server/db").closePool;

const read = <T,>(sql: string) => withSystem((q) => q.rows<T & Record<string, unknown>>(sql));
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const valid = (over: Record<string, string> = {}) =>
  form({ dealId: "d_garden", description: "Garden maintenance", amount: "4500.50", every: "month", startsOn: daysFromNow(10), dueDays: "7", ...over });

beforeAll(async () => {
  db = await startTestDb();
  ({ withSystem } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  actions = await import("../src/app/(app)/projects/actions");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

beforeEach(() =>
  db.seed(`
    DELETE FROM document_lines; DELETE FROM documents; DELETE FROM retainers; DELETE FROM deals;
    INSERT INTO deals (id, sub_account_id, title, value_cents, stage) VALUES ('d_garden', '${TENANT_A}', 'Garden', 0, 'won');
  `)
);

describe("setting one up", () => {
  it("KEEPS THE CENTS — 4500.50 is stored as 450050, not rounded", async () => {
    expect(await actions.createRetainerAction(undefined, valid())).toEqual({
      ok: "Retainer set up. Each invoice will be raised as a draft on its date for you to send.",
    });
    expect(await read(`SELECT amount_cents::text AS c, due_days FROM retainers`)).toEqual([{ c: "450050", due_days: 7 }]);
  });

  it("RAISES WHAT IS ALREADY DUE IN THE SAME PRESS, as a draft", async () => {
    const out = await actions.createRetainerAction(undefined, valid({ startsOn: daysFromNow(-2) }));
    expect(out?.ok).toMatch(/^Retainer set up\. INV-1001 is ready as a draft/);
    expect(await read(`SELECT status FROM documents`)).toEqual([{ status: "draft" }]);
  });

  it.each([
    [{ description: "" }, "Say what the retainer is for — it becomes the invoice line."],
    [{ amount: "0" }, "Enter the amount billed each period."],
    [{ amount: "-5" }, "Enter the amount billed each period."],
    [{ every: "week" }, "Choose how often it is billed."],
    [{ startsOn: "2026-02-30" }, "Choose the date of the first invoice."],
    [{ startsOn: daysFromNow(-400) }, "A retainer can start at most a year back. Raise older invoices by hand."],
    [{ endsOn: daysFromNow(5) }, "The end date is before the retainer starts."],
    [{ dueDays: "121" }, "Payment terms are between 0 and 120 days."],
  ])("refuses %j", async (over, error) => {
    expect(await actions.createRetainerAction(undefined, valid(over))).toEqual({ error });
    expect(await read(`SELECT id FROM retainers`)).toEqual([]);
  });
});

describe("running one", () => {
  const retainerId = async () => (await read<{ id: string }>(`SELECT id FROM retainers`))[0].id;

  it("pauses, resumes with the next date, and cancels with a plain explanation", async () => {
    await actions.createRetainerAction(undefined, valid());
    const id = await retainerId();
    expect(await actions.setRetainerStatusAction(undefined, form({ retainerId: id, to: "paused" }))).toEqual({
      ok: "Paused. Nothing is billed until you resume it.",
    });
    expect((await actions.setRetainerStatusAction(undefined, form({ retainerId: id, to: "active" })))?.ok).toMatch(
      /^Resumed\. The next invoice is dated \d+ \w{3} \d{4}\.$/
    );
    expect(await actions.setRetainerStatusAction(undefined, form({ retainerId: id, to: "cancelled" }))).toEqual({
      ok: "Cancelled. Invoices already raised stay on the project.",
    });
    expect(await actions.setRetainerStatusAction(undefined, form({ retainerId: id, to: "gone" }))).toEqual({
      error: "That change could not be made.",
    });
  });

  it("an edit changes what is billed next", async () => {
    await actions.createRetainerAction(undefined, valid());
    const id = await retainerId();
    expect(await actions.updateRetainerAction(undefined, valid({ retainerId: id, amount: "5000" }))).toEqual({
      ok: "Saved. Invoices already raised keep their figures.",
    });
    expect(await read(`SELECT amount_cents::text AS c FROM retainers`)).toEqual([{ c: "500000" }]);
  });
});
