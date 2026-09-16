import { describe, expect, it } from "vitest";
import {
  checkDraft,
  describeAutomation,
  matches,
  MOVABLE_STAGES,
  pickAssignee,
  type Automation,
} from "../src/server/automation-rules";

/**
 * What a rule decides, with no database: does it apply, whose turn is it, is it
 * a rule that makes sense, and how is it said.
 */

const rule = (over: Partial<Automation> = {}): Automation => ({
  id: "au_1",
  eventKind: "lead_created",
  whenSource: null,
  whenStage: null,
  actionKind: "assign_owner",
  assigneeIds: ["u_sam"],
  targetStage: null,
  taskTitle: null,
  taskDueDays: null,
  rotationPosition: 0,
  enabled: true,
  createdAt: "2026-09-16T00:00:00.000Z",
  ...over,
});

describe("whether a rule applies", () => {
  it("a lead rule with no source applies to a lead from anywhere", () => {
    expect(matches(rule(), { kind: "lead_created", source: "phone_call" })).toBe(true);
  });

  it("A LEAD RULE FOR ONE SOURCE IGNORES EVERY OTHER", () => {
    const website = rule({ whenSource: "website" });
    expect(matches(website, { kind: "lead_created", source: "website" })).toBe(true);
    expect(matches(website, { kind: "lead_created", source: "referral" })).toBe(false);
  });

  it("a stage rule applies only to a move into its stage", () => {
    const won = rule({ eventKind: "deal_stage_changed", whenStage: "won" });
    expect(matches(won, { kind: "deal_stage_changed", to: "won" })).toBe(true);
    expect(matches(won, { kind: "deal_stage_changed", to: "delivery" })).toBe(false);
  });

  it("a rule never answers an event of the other kind", () => {
    expect(matches(rule(), { kind: "deal_stage_changed", to: "prospect" })).toBe(false);
  });

  it("A SWITCHED-OFF RULE APPLIES TO NOTHING", () => {
    expect(matches(rule({ enabled: false }), { kind: "lead_created", source: "website" })).toBe(false);
  });
});

describe("whose turn it is", () => {
  const everyone = new Set(["a", "b", "c"]);

  it("takes turns in order and wraps round", () => {
    const ids = ["a", "b", "c"];
    let position = 0;
    const got: string[] = [];
    for (let i = 0; i < 5; i++) {
      const pick = pickAssignee(ids, position, everyone)!;
      got.push(pick.userId);
      position = pick.nextPosition;
    }
    expect(got).toEqual(["a", "b", "c", "a", "b"]);
  });

  it("STEPS OVER SOMEBODY WHO CAN NO LONGER TAKE WORK, and the next turn follows whoever got it", () => {
    const pick = pickAssignee(["a", "b", "c"], 0, new Set(["b", "c"]))!;
    expect(pick).toEqual({ userId: "b", nextPosition: 2 });
  });

  it("wraps past the end when stepping over", () => {
    expect(pickAssignee(["a", "b", "c"], 2, new Set(["a"]))).toEqual({ userId: "a", nextPosition: 1 });
  });

  it("copes with a stored position beyond the list, as after somebody is removed from it", () => {
    expect(pickAssignee(["a", "b"], 7, everyone)).toEqual({ userId: "b", nextPosition: 0 });
  });

  it("IS NULL WHEN NOBODY ON THE LIST CAN TAKE IT, never somebody not on it", () => {
    expect(pickAssignee(["a", "b"], 0, new Set(["z"]))).toBeNull();
    expect(pickAssignee([], 0, everyone)).toBeNull();
  });
});

describe("checking a rule somebody built", () => {
  const form = (over: Record<string, unknown> = {}) => ({
    eventKind: "lead_created",
    whenSource: "any",
    whenStage: null,
    actionKind: "assign_owner",
    assigneeIds: ["u_sam"],
    targetStage: null,
    ...over,
  });

  it("accepts a lead rule for any source, keeping no stage", () => {
    expect(checkDraft(form())).toEqual({
      draft: {
        eventKind: "lead_created",
        whenSource: null,
        whenStage: null,
        actionKind: "assign_owner",
        assigneeIds: ["u_sam"],
        targetStage: null,
        taskTitle: null,
        taskDueDays: null,
      },
    });
  });

  it("ACCEPTS A TASK RULE WITH ITS WORDING AND DAY, and nothing else", () => {
    const out = checkDraft(
      form({ actionKind: "create_task", taskTitle: "  Call   them back ", taskDueDays: "1", assigneeIds: ["u_sam"], targetStage: "won" })
    );
    expect("draft" in out && out.draft).toMatchObject({
      actionKind: "create_task",
      taskTitle: "Call them back",
      taskDueDays: 1,
      assigneeIds: [],
      targetStage: null,
    });
  });

  it.each([
    ["no wording", { taskTitle: "   ", taskDueDays: "0" }, /what the task should be/],
    ["a day that is not offered", { taskTitle: "Call", taskDueDays: "5" }, /when the task is due/],
    ["no day at all", { taskTitle: "Call" }, /when the task is due/],
  ])("refuses a task rule with %s", (_what, over, pattern) => {
    const out = checkDraft(form({ actionKind: "create_task", ...over }));
    expect("error" in out && out.error).toMatch(pattern);
  });

  it("drops a stage posted alongside a lead rule, and a source alongside a stage rule", () => {
    const lead = checkDraft(form({ whenStage: "won" }));
    expect("draft" in lead && lead.draft.whenStage).toBe(null);
    const stage = checkDraft(form({ eventKind: "deal_stage_changed", whenStage: "won", whenSource: "website" }));
    expect("draft" in stage && stage.draft.whenSource).toBe(null);
  });

  it("KEEPS THE ORDER PEOPLE WERE CHOSEN IN, without repeats", () => {
    const out = checkDraft(form({ assigneeIds: ["u_kim", "u_sam", "u_kim", ""] }));
    expect("draft" in out && out.draft.assigneeIds).toEqual(["u_kim", "u_sam"]);
  });

  it.each([
    ["an unknown trigger", { eventKind: "invoice_overdue" }, /start this automation/],
    ["an unknown source", { whenSource: "carrier_pigeon" }, /lead source/],
    ["a stage rule with no stage", { eventKind: "deal_stage_changed" }, /stage that should start/],
    ["an unknown action", { actionKind: "send_email" }, /should do/],
    ["nobody to give it to", { assigneeIds: [] }, /who should get it/],
    ["too many people", { assigneeIds: Array.from({ length: 21 }, (_, i) => `u_${i}`) }, /up to 20/],
    ["a move with no stage", { actionKind: "move_stage" }, /stage to move it to/],
  ])("refuses %s", (_what, over, pattern) => {
    const out = checkDraft(form(over));
    expect("error" in out && out.error).toMatch(pattern);
  });

  it("REFUSES A RULE THAT MARKS DEALS LOST, which needs a reason only a person has", () => {
    const out = checkDraft(form({ actionKind: "move_stage", targetStage: "lost" }));
    expect("error" in out && out.error).toMatch(/reason/);
    expect(MOVABLE_STAGES).not.toContain("lost");
  });

  it("refuses moving a deal to the stage it has just arrived at", () => {
    const out = checkDraft(
      form({ eventKind: "deal_stage_changed", whenStage: "won", actionKind: "move_stage", targetStage: "won" })
    );
    expect("error" in out && out.error).toMatch(/just arrived/);
  });
});

describe("saying a rule in English", () => {
  const names: Record<string, string> = { u_sam: "Sam Lee", u_kim: "Kim Park" };
  const say = (over: Partial<Automation>) => describeAutomation(rule(over), (id) => names[id]);

  it("names one person plainly", () => {
    expect(say({ whenSource: "website" })).toEqual({
      when: "A new lead comes in from Website",
      then: "Give it to Sam Lee",
    });
  });

  it("says a rotation takes turns, in order", () => {
    expect(say({ assigneeIds: ["u_kim", "u_sam"] }).then).toBe("Take turns: Kim Park, Sam Lee");
  });

  it("says somebody has left rather than showing an id", () => {
    expect(say({ assigneeIds: ["u_gone"] }).then).toBe("Give it to someone who has left");
  });

  it("says what a task rule adds and when it is due", () => {
    expect(say({ actionKind: "create_task", taskTitle: "Call them back", taskDueDays: 0, assigneeIds: [] }).then).toBe(
      "Add the task “Call them back” for whoever owns it, due the same day"
    );
  });

  it("uses the board's own stage names", () => {
    expect(
      say({ eventKind: "deal_stage_changed", whenStage: "won", actionKind: "move_stage", targetStage: "delivery", assigneeIds: [] })
    ).toEqual({ when: "A deal moves to Closed Won", then: "Move it to Delivery" });
  });
});
