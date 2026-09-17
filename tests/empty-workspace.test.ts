import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What a workspace with nothing in it is told.
 *
 * "Inbox zero 🎉", "You're all caught up", "Nothing open. Every lead is either
 * won or closed" — all true of somebody who has cleared their desk, all false
 * on the first screen after signing up. Two different nothings: one is praise
 * for work done, the other is a first step not yet taken. Saying the first
 * when the second is true congratulates a person for nothing, and — in the
 * leads case — asserts something about records that do not exist.
 *
 * Found on 2026-09-18 by signing up a real new tenant in dev and driving all
 * seventeen pages as that person.
 *
 * These read the source rather than render it, like `reports-metrics.test.ts`:
 * what is being checked is that the celebratory sentence is behind a condition
 * at all, which is a property of the code, not of one rendering of it.
 */

const strip = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const read = (p: string) => strip(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));

const home = read("../src/app/(app)/page.tsx");
const leads = read("../src/app/(app)/leads/page.tsx");
const target = read("../src/app/(app)/reports/SalesTargetCard.tsx");

describe("a brand-new workspace", () => {
  it("IS NOT CONGRATULATED for work it has not done", () => {
    /* Every celebration has to sit behind `started`, which is the test for
       whether this workspace holds anything at all. */
    for (const praise of ["Inbox zero", "You're all caught up", "you're clear", "Nothing on the calendar"]) {
      const at = home.indexOf(praise);
      expect(at, `"${praise}" is not on the page any more — update this test`).toBeGreaterThan(-1);
      const clause = home.slice(Math.max(0, at - 220), at);
      expect(clause, `"${praise}" is shown without checking the workspace has anything in it`).toMatch(
        /started/
      );
    }
  });

  it("defines `started` from something real, not from a flag somebody sets", () => {
    expect(home).toMatch(/const started = contacts\.length > 0;/);
  });

  it("is not greeted with a summary of a day that has nothing in it", () => {
    const at = home.indexOf("You have ${meetingsToday.length}");
    expect(at).toBeGreaterThan(-1);
    expect(home.slice(Math.max(0, at - 200), at)).toMatch(/started/);
  });

  it("IS NOT TOLD ITS LEADS ARE ALL WON OR CLOSED when it has no leads", () => {
    const at = leads.indexOf("Every lead is either won or closed");
    expect(at).toBeGreaterThan(-1);
    expect(leads.slice(Math.max(0, at - 200), at), "the claim is made unconditionally").toMatch(
      /anyLeads/
    );
    expect(leads).toMatch(/anyLeads=\{leads\.length > 0\}/);
  });

  it("is not shown a sales target of zero as though somebody set one", () => {
    expect(target).toMatch(/target > 0 \? money\(target\) : "Not set"/);
  });
});
