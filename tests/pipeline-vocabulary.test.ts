import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BOARD_STAGES, stageMeta, carriesMoney, isWonStage } from "../src/data/pipeline";
import { STAGES } from "../src/server/repos/deals";

/**
 * The words on screen name stages that exist.
 *
 * The pipeline was rebuilt on the real six stages, and the labels around it
 * were not. Months later the board still told people to "click one in
 * Negotiations to record a payment" — a stage deleted long before — and a
 * summary tile read "Negotiations Owed · Invoiced, awaiting payment" while
 * summing the DISCOVERY column. Nobody has invoiced a deal they are still
 * qualifying, so that tile reported money owed that had never been asked for.
 *
 * The label was stale; the number underneath it was false. Static text is where
 * this rots, because no test looks at it and no type checks it.
 */

const SRC = join(__dirname, "..", "src");

const walk = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((f) => {
        const full = join(dir, f);
        if (statSync(full).isDirectory()) return walk(full);
        return /\.(ts|tsx)$/.test(f) ? [full] : [];
      });

/**
 * Stage names from the pipeline nobody actually ran.
 *
 * "Qualified" is deliberately absent: it is also a call outcome ("Qualified
 * Lead"), a legitimate word in a different part of the product. A guard that
 * fires on correct code gets weakened or ignored, and both are worse than the
 * gap — so this list holds only names with no other meaning here.
 */
const DELETED_STAGES = [
  "Lead In",
  "Leads In",
  "Proposal",
  "Proposals",
  "Negotiation",
  "Negotiations",
  "Weighted Forecast",
];

describe("no screen names a stage that was deleted", () => {
  const files = walk(SRC);

  it("finds the sources (a suite matching nothing proves nothing)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("uses none of the invented stage names in text a person can read", () => {
    /**
     * Comments are stripped first. Several of them explain what these names
     * were and why they went, which is worth keeping — and matching them would
     * make the check impossible to satisfy without deleting the history.
     */
    const offenders: string[] = [];
    for (const path of files) {
      const code = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const name of DELETED_STAGES) {
        if (new RegExp(`\\b${name}\\b`).test(code)) {
          offenders.push(`${path.split("/src/")[1]} → "${name}"`);
        }
      }
    }
    expect(
      offenders,
      `these name stages that no longer exist:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});

describe("the board and the database agree about the stages", () => {
  it("shows every stage except Lost", () => {
    // Lost is real — it is why Win Rate can be computed at all — but a column
    // of dead deals beside live work is clutter that gets ignored.
    expect(BOARD_STAGES.map((s) => s.id)).toEqual(STAGES.filter((s) => s !== "lost"));
  });

  it("gives every stage a label and an exit condition", () => {
    for (const id of STAGES) {
      const meta = stageMeta(id);
      expect(meta.label.length, `${id} has no label`).toBeGreaterThan(0);
      expect(meta.exit.length, `${id} has no exit condition`).toBeGreaterThan(10);
    }
  });

  it("states what has to happen next, not what the column is called", () => {
    /**
     * The question a board has to answer is "what must happen for this card to
     * move". A hint that restates the label answers nothing, and it is the
     * default thing to write.
     */
    for (const id of STAGES) {
      const { label, exit } = stageMeta(id);
      expect(
        exit.toLowerCase().replace(/[^a-z]/g, "") === label.toLowerCase().replace(/[^a-z]/g, ""),
        `${id}'s exit condition just repeats its label`
      ).toBe(false);
    }
  });

  it("does not claim Won exits on payment", () => {
    /**
     * Payment is what puts a deal in Won: recording one creates the won record
     * and stamps `won_at`, and dragging a card in does the same. Describing
     * payment as the EXIT made the board contradict the app, which refuses to
     * record a payment against a deal already in Won — so the column announced
     * a transition the product would not perform.
     */
    expect(stageMeta("won").exit.toLowerCase()).not.toMatch(/exits on payment/);
  });
});

describe("money is only claimed where money is real", () => {
  it("puts no value on a prospect", () => {
    // A prospect nobody has spoken to has no value worth adding up, and
    // inventing one puts imaginary money in the pipeline total.
    expect(carriesMoney("prospect"), "a prospect was given a value").toBe(false);
  });

  it("carries money from Discovery onwards", () => {
    for (const id of ["discovery", "demo", "won", "delivery", "referral"] as const) {
      expect(carriesMoney(id), `${id} should carry a value`).toBe(true);
    }
  });

  it("keeps a won deal won through Delivery and Referral", () => {
    /**
     * Won-ness is a recorded fact, never a position on the board. Reading it
     * from the column would make revenue FALL the moment delivery began — the
     * business would appear to lose money by doing the work it was paid for.
     */
    expect(isWonStage("won")).toBe(true);
    expect(isWonStage("delivery")).toBe(true);
    expect(isWonStage("referral")).toBe(true);
    expect(isWonStage("demo")).toBe(false);
    expect(isWonStage("lost")).toBe(false);
  });
});
