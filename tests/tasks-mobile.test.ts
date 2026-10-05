/*
   Tasks has to open on the tasks.

   On a 375px screen the add-a-task form was always fully expanded — a title
   field, a day, a person and a job — and with the heading and the Mine/Everyone
   tabs above them it filled the top third of the phone before a single task
   appeared. The list is what the page is for, and Bradley's standing rule is
   that everything should fit without scrolling to see it.

   So the three selects wait until somebody is actually writing a task, which is
   the moment they mean anything. They are still in the form while hidden, so a
   one-line task posts with today, me and no job exactly as it did.

   The other half of the rule is that mobile work does not change the desktop.
   Above 560px the row is never hidden.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const form = readFileSync(`${process.cwd()}/src/components/tasks/NewTaskForm.tsx`, "utf8");

describe("the add-a-task form on a phone", () => {
  it("starts as one line, and opens when somebody writes", () => {
    expect(form).toMatch(/const \[writing, setWriting\] = useState\(false\)/);
    expect(form).toMatch(/onFocus=\{\(\) => setWriting\(true\)\}/);
    expect(form).toMatch(/writing \|\| compact/);
  });

  it("NEVER puts `hidden` and a display utility on the same element", () => {
    /*
       This project's own failure log: `hidden` beside a display utility is
       decided by stylesheet order rather than by intent, and the one that wins
       is not the one you meant. The two states are therefore written as two
       complete class strings rather than a base plus an override.
    */
    const block = form.slice(form.indexOf("className={clsx("), form.indexOf("<label className=\"block min-w-0\">"));
    const shown = /"grid grid-cols-2 gap-2"/.test(block);
    const hiddenState = /"hidden grid-cols-2 gap-2 @min-\[560px\]:grid"/.test(block);
    expect(shown, "the open state is not a plain grid").toBe(true);
    expect(hiddenState, "the closed state is not a plain hidden").toBe(true);
    /* The closed string must not also carry a bare `grid`. */
    expect(block).not.toMatch(/"hidden [^"]*\bgrid\b[^"]*grid-cols-2/);
  });

  it("leaves a wide screen exactly as it was", () => {
    /* Hidden only below 560px — above it the row is grid, always, which is
       what the desktop had before any of this. */
    expect(form).toMatch(/@min-\[560px\]:grid"/);
    expect(form).toMatch(/!compact && "@min-\[560px\]:grid-cols-3"/);
  });

  it("still posts the day, the person and the job while they are hidden", () => {
    /* display:none does not stop a select being submitted, which is the whole
       reason this works — a one-line task keeps its defaults. */
    for (const name of ['name="dueOn"', 'name="assignee"', 'name="dealId"']) {
      expect(form, `${name} is no longer part of the form`).toContain(name);
    }
    expect(form).toMatch(/defaultValue=\{today\}/);
  });
});
