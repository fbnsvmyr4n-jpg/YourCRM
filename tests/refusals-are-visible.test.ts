import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A refusal must never look like a success.
 *
 * Found by driving the product as a view-only user: pressing Save Lead closed
 * the dialog exactly as a successful save does, and no lead existed. The screen
 * awaited the server action and then closed the form without ever looking at
 * what came back — so the view-only refusal disappeared, and so did every other
 * refusal that action can return, including a name the server could not read.
 *
 * `withCurrentTenant` hands back `{ error: … }` for a view-only user on EVERY
 * action in the product, which is what makes this worth a test of its own: the
 * same three lines of carelessness silently disable the whole application for
 * one of the five roles.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("the lead form", () => {
  const view = read("../src/app/(app)/leads/LeadCardsSection.tsx");
  const actions = read("../src/app/(app)/leads/actions.ts");

  it("CLOSES ONLY WHEN THE SAVE SUCCEEDED", () => {
    /* The close has to sit behind a check of the result. Written the other way
       round — close first, then look — is exactly the bug. */
    const fn = view.slice(view.indexOf("async function handleSubmit"), view.indexOf("async function handleDelete"));
    expect(fn).toMatch(/if \(result && "error" in result\)/);
    const refusal = fn.indexOf('"error" in result');
    const close = fn.indexOf("setModal(null)");
    expect(refusal, "the result is never inspected").toBeGreaterThan(-1);
    expect(close, "the form is never closed").toBeGreaterThan(refusal);
  });

  it("SAYS WHY, where somebody who just pressed Save is looking", () => {
    expect(view).toMatch(/role="alert"/);
    expect(view).toMatch(/\{problem\}/);
  });

  it("KEEPS WHAT WAS TYPED when the save is refused", () => {
    /* React 19 resets an uncontrolled field after every action, refused ones
       included. This form posts through a plain `action` prop rather than
       `useActionState`, so the guard that catches this elsewhere never looked
       here — and showing the reason over an emptied form is half a fix. */
    expect(view).toMatch(/const value = \(name: string, fromRecord\?: string\)/);
    for (const field of ["name", "email", "phone", "location", "company", "source"]) {
      expect(view, `${field} is not kept across a refusal`).toMatch(
        new RegExp(`defaultValue=\\{value\\("${field}"`)
      );
    }
  });

  it("says out loud that a delete did not happen", () => {
    const fn = view.slice(view.indexOf("async function handleDelete"));
    expect(fn.slice(0, 900)).toMatch(/"error" in result/);
  });

  it("GIVES THE SCREEN AN ANSWER IT CANNOT MISREAD", () => {
    /* One shape with two readings. The old return was the new contact's id, or
       null, or the refusal object — three shapes, and the caller treated all of
       them as success. */
    expect(actions).toMatch(/export type LeadResult = \{ ok: true; id\?: string \} \| \{ error: string \}/);
    for (const fn of ["addLeadAction", "updateLeadAction", "deleteLeadAction"]) {
      expect(actions, `${fn} does not promise a readable answer`).toMatch(
        new RegExp(`export async function ${fn}\\([^)]*\\): Promise<LeadResult>`)
      );
    }
  });
});

describe("the greeting on Home", () => {
  const home = read("../src/app/(app)/page.tsx");

  it("USES THE BUSINESS'S HOUR, not the server's", () => {
    /* Caught side by side on one screen during the role audit: the workspace
       clock read 22:01 and the line beneath it said "Good morning", because the
       hour came from the server — UTC on Vercel. A Johannesburg business would
       be wished good evening from four in the afternoon. */
    expect(home).toMatch(/greeting\(businessHour\)/);
    expect(home).not.toMatch(/greeting\(now\.getHours\(\)\)/);
    expect(home).toMatch(/instantToWallClock\(now\.toISOString\(\), timeZone\)/);
  });
});
