import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb, TENANT_A, TENANT_B, AGENCY, USER_A } from "./helpers/pg";
import type { TenantContext } from "../src/server/tenant";

/**
 * The meetings repository.
 *
 * The audit rated this entity's outcome model as the one the deal pipeline
 * should have copied, so most of these tests exist to prove the port kept it
 * intact rather than quietly re-deriving it. The two properties that matter:
 * an outcome is recorded rather than inferred from the clock, and every rate is
 * computed out of meetings whose outcome is actually known.
 *
 * RLS is bypassed in this harness (see `helpers/pg.ts`), so the isolation cases
 * prove the repository's own predicates under the conditions a superuser
 * connection would face.
 */

let db: TestDb;
let withTenant: typeof import("../src/server/tenant").withTenant;
let repo: typeof import("../src/server/repos/meetings");
let closePool: typeof import("../src/server/db").closePool;

const ctxFor = (subAccountId: string): TenantContext => ({
  agencyId: AGENCY,
  subAccountId,
  userId: USER_A,
  role: "owner",
});

beforeAll(async () => {
  db = await startTestDb();
  ({ withTenant } = await import("../src/server/tenant"));
  ({ closePool } = await import("../src/server/db"));
  repo = await import("../src/server/repos/meetings");
});

afterAll(async () => {
  await closePool?.();
  await db.stop();
});

const inA = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_A), fn);
const inB = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctxFor(TENANT_B), fn);

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

const book = (over: Partial<Parameters<typeof repo.createMeeting>[1]> = {}) =>
  inA((q) => repo.createMeeting(q, { topic: "Discovery call", scheduledAt: hours(24), ...over }));

/** Reset between statistics tests, which are the only ones sensitive to siblings. */
const clearMeetings = () => db.seed(`DELETE FROM meetings`);

describe("booking and reading", () => {
  it("round-trips a meeting and starts with no outcome recorded", async () => {
    const m = await book({ topic: "  Kickoff  ", durationMin: 45, kind: "in_person" });
    expect(m.topic, "input was not trimmed").toBe("Kickoff");
    expect(m.durationMin).toBe(45);
    expect(m.kind).toBe("in_person");
    expect(m.outcome, "a new meeting already has an outcome").toBe("scheduled");
    expect(m.lossReason).toBeNull();

    expect((await inA((q) => repo.getMeeting(q, m.id)))?.id).toBe(m.id);
  });

  it("rejects an unparseable time instead of passing it to the driver", async () => {
    await expect(book({ scheduledAt: "next tuesday-ish" })).rejects.toThrow(/valid date/i);
  });

  it("rejects a nonsensical duration", async () => {
    await expect(book({ durationMin: 0 })).rejects.toThrow(/whole minutes/i);
    await expect(book({ durationMin: 12.5 })).rejects.toThrow(/whole minutes/i);
    await expect(book({ durationMin: 5000 })).rejects.toThrow(/range/i);
  });
});

describe("upcoming means still ahead AND still open", () => {
  it("excludes meetings in the past", async () => {
    await clearMeetings();
    const past = await book({ topic: "Yesterday", scheduledAt: hours(-24) });
    const future = await book({ topic: "Tomorrow", scheduledAt: hours(24) });

    const ids = (await inA((q) => repo.listUpcoming(q))).map((x) => x.id);
    expect(ids).toContain(future.id);
    expect(ids).not.toContain(past.id);
  });

  it("excludes a meeting whose outcome is already recorded", async () => {
    /**
     * The subtle one. A meeting marked as a no-show should not sit in
     * "upcoming" just because its start time has not passed — otherwise the
     * list keeps showing work that is already dealt with, and the user learns
     * to ignore it.
     */
    await clearMeetings();
    const m = await book({ scheduledAt: hours(2) });
    await inA((q) => repo.recordOutcome(q, m.id, "no_show"));
    expect((await inA((q) => repo.listUpcoming(q))).map((x) => x.id)).not.toContain(m.id);
  });

  it("returns them soonest first", async () => {
    await clearMeetings();
    const later = await book({ topic: "Later", scheduledAt: hours(48) });
    const sooner = await book({ topic: "Sooner", scheduledAt: hours(6) });
    expect((await inA((q) => repo.listUpcoming(q))).map((x) => x.id)).toEqual([
      sooner.id,
      later.id,
    ]);
  });

  it("lists a date range half-open, so a day boundary belongs to one day only", async () => {
    // `>= from AND < to`: an inclusive upper bound would show a midnight
    // meeting on both days and double-count it in any per-day total.
    await clearMeetings();
    const from = new Date(Date.now() + 3_600_000);
    const to = new Date(from.getTime() + 3_600_000);
    const inside = await book({ topic: "Inside", scheduledAt: from.toISOString() });
    const onBoundary = await book({ topic: "Boundary", scheduledAt: to.toISOString() });

    const ids = (await inA((q) => repo.listBetween(q, from, to))).map((x) => x.id);
    expect(ids).toContain(inside.id);
    expect(ids, "the upper bound was inclusive").not.toContain(onBoundary.id);
  });
});

describe("outcomes are recorded, never inferred", () => {
  it("leaves a past meeting as scheduled until somebody says what happened", async () => {
    // Inferring "showed" from the clock would invent data. Nobody attended
    // anything just because time passed.
    await clearMeetings();
    const m = await book({ scheduledAt: hours(-48) });
    expect((await inA((q) => repo.getMeeting(q, m.id)))?.outcome).toBe("scheduled");
  });

  it("requires a reason for a lost meeting", async () => {
    const m = await book();
    await expect(inA((q) => repo.recordOutcome(q, m.id, "lost"))).rejects.toThrow(/reason/i);
    await expect(
      inA((q) => repo.recordOutcome(q, m.id, "lost", { lossReason: "  " }))
    ).rejects.toThrow(/reason/i);
  });

  it("clears the loss reason when the outcome changes", async () => {
    const m = await book();
    await inA((q) => repo.recordOutcome(q, m.id, "lost", { lossReason: "Budget pulled" }));
    const changed = await inA((q) => repo.recordOutcome(q, m.id, "showed"));
    expect(changed?.lossReason, "a stale explanation survived the outcome changing").toBeNull();
  });

  it("refuses an outcome it does not recognise", async () => {
    const m = await book();
    await expect(inA((q) => repo.recordOutcome(q, m.id, "rescheduled" as never))).rejects.toThrow(
      /outcome/i
    );
  });

  it("cannot be set through updateMeeting", async () => {
    const m = await book();
    await inA((q) => repo.updateMeeting(q, m.id, { outcome: "won" } as never));
    expect((await inA((q) => repo.getMeeting(q, m.id)))?.outcome).toBe("scheduled");
  });
});

describe("statistics count only what is known", () => {
  it("reports no rate at all when nothing has been recorded", async () => {
    /**
     * The product rule: never render an invented number. "No data" and "0%" are
     * different claims, and a 0% show rate on a brand-new account is a lie that
     * looks like a metric. Nullable at the source, so no component can default
     * it to zero on the way out.
     */
    await clearMeetings();
    await book();
    await book();
    const s = await inA((q) => repo.meetingStats(q));
    expect(s).toMatchObject({ total: 2, pending: 2, recorded: 0 });
    expect(s.showRate, "an unrecorded account shows a real-looking show rate").toBeNull();
    expect(s.winRate).toBeNull();
  });

  it("excludes pending meetings from the denominator", async () => {
    // Counting still-open meetings as failures makes the show rate fall every
    // time one is booked — the same arithmetic error the deal pipeline had.
    await clearMeetings();
    const showed = await book();
    await inA((q) => repo.recordOutcome(q, showed.id, "showed"));
    const missed = await book();
    await inA((q) => repo.recordOutcome(q, missed.id, "no_show"));
    await book(); // still pending

    const s = await inA((q) => repo.meetingStats(q));
    expect(s).toMatchObject({ total: 3, pending: 1, recorded: 2, attended: 1, noShow: 1 });
    expect(s.showRate, "pending meetings leaked into the denominator").toBe(50);
  });

  it("counts every attended outcome as attended, not just 'showed'", async () => {
    await clearMeetings();
    for (const o of ["showed", "advanced", "won"] as const) {
      const m = await book();
      await inA((q) => repo.recordOutcome(q, m.id, o));
    }
    const lost = await book();
    await inA((q) => repo.recordOutcome(q, lost.id, "lost", { lossReason: "Price" }));

    const s = await inA((q) => repo.meetingStats(q));
    expect(s.attended, "a meeting that advanced or was lost still happened").toBe(4);
    expect(s.showRate).toBe(100);
  });

  it("computes win rate out of decided meetings only", async () => {
    await clearMeetings();
    const won = await book();
    await inA((q) => repo.recordOutcome(q, won.id, "won"));
    const lost = await book();
    await inA((q) => repo.recordOutcome(q, lost.id, "lost", { lossReason: "Timing" }));
    const open = await book();
    await inA((q) => repo.recordOutcome(q, open.id, "showed"));

    const s = await inA((q) => repo.meetingStats(q));
    expect(s.winRate, "an undecided meeting was counted as a loss").toBe(50);
  });

  it("ignores deleted meetings", async () => {
    await clearMeetings();
    const m = await book();
    await inA((q) => repo.recordOutcome(q, m.id, "won"));
    await inA((q) => repo.deleteMeeting(q, m.id));
    expect((await inA((q) => repo.meetingStats(q))).total).toBe(0);
  });

  it("counts only the caller's tenant", async () => {
    await clearMeetings();
    await book();
    expect((await inB((q) => repo.meetingStats(q))).total, "another tenant's meetings were counted").toBe(0);
  });
});

describe("deletion is soft and reversible", () => {
  it("hides and restores", async () => {
    const m = await book();
    expect(await inA((q) => repo.deleteMeeting(q, m.id))).toBe(true);
    expect(await inA((q) => repo.getMeeting(q, m.id))).toBeNull();
    expect(await inA((q) => repo.restoreMeeting(q, m.id))).toBe(true);
    expect(await inA((q) => repo.getMeeting(q, m.id))).not.toBeNull();
  });
});

describe("the tenant boundary holds", () => {
  it("hides and refuses every cross-tenant operation", async () => {
    const m = await book({ topic: "Mine" });
    expect(await inB((q) => repo.getMeeting(q, m.id))).toBeNull();
    expect(await inB((q) => repo.updateMeeting(q, m.id, { topic: "Stolen" }))).toBeNull();
    expect(await inB((q) => repo.recordOutcome(q, m.id, "no_show"))).toBeNull();
    expect(await inB((q) => repo.deleteMeeting(q, m.id))).toBe(false);

    const mine = await inA((q) => repo.getMeeting(q, m.id));
    expect(mine?.topic, "another tenant modified this meeting").toBe("Mine");
    expect(mine?.outcome).toBe("scheduled");
  });
});
