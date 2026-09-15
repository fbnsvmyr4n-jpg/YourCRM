import { describe, expect, it } from "vitest";
import { documentsByStage, type StageTask } from "../src/server/stage-money";
import type { ProjectDocument } from "../src/server/repos/projects";

/**
 * The Documents tab, arranged by the stage of the job.
 *
 * A client quotation covers the whole job; a purchase order covers one piece.
 * So documents are grouped by where their LINES are filed, and the same
 * quotation appears under several stages. The properties worth defending are
 * that each appearance shows only that stage's part, that nothing filed gets
 * lost, and that a stage with nothing yet is still there to raise paperwork on.
 *
 * Every figure below was worked out by hand first.
 */

const line = (id: string, cents: number, taskId: string | null) => ({
  id,
  description: id,
  quantity: 1,
  unitCents: cents,
  totalCents: cents,
  projectTaskId: taskId,
});

const doc = (
  id: string,
  kind: ProjectDocument["kind"],
  status: ProjectDocument["status"],
  lines: ReturnType<typeof line>[]
): ProjectDocument => ({
  id,
  kind,
  number: id.toUpperCase(),
  status,
  party: null,
  issuedOn: null,
  dueOn: null,
  notes: null,
  sentAt: null,
  lines,
  totalCents: lines.reduce((n, l) => n + l.totalCents, 0),
});

/* Plan order is by position, not by name or by the order given. */
const TASKS: StageTask[] = [
  { id: "t_clear", name: "Site clearance", position: 2 },
  { id: "t_steel", name: "Steel frame", position: 1 },
  { id: "t_hand", name: "Handover", position: 3 },
];

/*
   quote Q1 accepted   $250,000 clearance · $1,000,000 steel · $100,000 unfiled
   PO1       sent      $600,000 steel
   INV1      sent      $250,000 clearance          (an invoice: listed, never counted)
   PO2       draft     $30,000 unfiled · $20,000 unfiled
*/
const DOCS = [
  doc("q1", "quote", "accepted", [
    line("q1-clear", 25_000_000, "t_clear"),
    line("q1-steel", 100_000_000, "t_steel"),
    line("q1-extra", 10_000_000, null),
  ]),
  doc("po1", "purchase_order", "sent", [line("po1-steel", 60_000_000, "t_steel")]),
  doc("inv1", "invoice", "sent", [line("inv1-clear", 25_000_000, "t_clear")]),
  doc("po2", "purchase_order", "draft", [line("po2-a", 3_000_000, null), line("po2-b", 2_000_000, null)]),
];

describe("grouping by stage", () => {
  const grouped = documentsByStage(DOCS, TASKS);

  it("lists the stages in plan order, including the empty one", () => {
    expect(grouped.stages.map((s) => s.task.name)).toEqual(["Steel frame", "Site clearance", "Handover"]);
  });

  it("SHOWS ONLY EACH STAGE'S PART OF A DOCUMENT THAT SPANS SEVERAL", () => {
    const steel = grouped.stages[0];
    expect(steel.entries.map((e) => [e.document.number, e.totalCents, e.lines.length])).toEqual([
      ["Q1", 100_000_000, 1],
      ["PO1", 60_000_000, 1],
    ]);
    // The whole document is still reachable, so a screen can say "part of $X".
    expect(steel.entries[0].document.totalCents).toBe(135_000_000);

    const clearance = grouped.stages[1];
    expect(clearance.entries.map((e) => [e.document.number, e.totalCents])).toEqual([
      ["Q1", 25_000_000],
      ["INV1", 25_000_000],
    ]);
  });

  it("carries each stage's money by the same rules as the Timeline", () => {
    expect(grouped.stages[0].money).toMatchObject({
      quotedCents: 100_000_000,
      committedCents: 60_000_000,
      marginCents: 40_000_000,
    });
    // The invoice line on clearance is listed but not counted.
    expect(grouped.stages[1].money).toMatchObject({ quotedCents: 25_000_000, committedCents: 0 });
  });

  it("keeps a stage with nothing filed, with no money rather than zero money", () => {
    const handover = grouped.stages[2];
    expect(handover.entries).toEqual([]);
    expect(handover.money).toBeNull();
  });

  it("PUTS EVERY UNFILED LINE SOMEWHERE VISIBLE, and only the unfiled ones", () => {
    expect(grouped.unfiled.map((e) => [e.document.number, e.lines.map((l) => l.id), e.totalCents])).toEqual([
      ["Q1", ["q1-extra"], 10_000_000],
      ["PO2", ["po2-a", "po2-b"], 5_000_000],
    ]);
  });

  it("loses no line: every line appears exactly once across stages and unfiled", () => {
    const shown = [
      ...grouped.stages.flatMap((s) => s.entries.flatMap((e) => e.lines.map((l) => l.id))),
      ...grouped.unfiled.flatMap((e) => e.lines.map((l) => l.id)),
    ].sort();
    const all = DOCS.flatMap((d) => d.lines.map((l) => l.id)).sort();
    expect(shown).toEqual(all);
  });

  it("treats a line filed to a stage that is no longer in the plan as unfiled", () => {
    const orphan = [doc("po9", "purchase_order", "sent", [line("po9-a", 1_000, "t_deleted")])];
    const g = documentsByStage(orphan, TASKS);
    expect(g.stages.every((s) => s.entries.length === 0)).toBe(true);
    expect(g.unfiled.map((e) => e.lines[0].id)).toEqual(["po9-a"]);
  });

  it("with no plan at all, everything is unfiled and there are no stages", () => {
    const g = documentsByStage(DOCS, []);
    expect(g.stages).toEqual([]);
    expect(g.unfiled.flatMap((e) => e.lines).length).toBe(7);
  });
});
