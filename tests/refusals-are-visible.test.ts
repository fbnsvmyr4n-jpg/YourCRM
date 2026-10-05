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

describe("the deals board", () => {
  const board = read("../src/app/(app)/deals/DealsBoard.tsx");
  const actions = read("../src/app/(app)/deals/actions.ts");

  it("DOES NOT RE-PRICE A DEAL THE SERVER REFUSED TO RE-PRICE", () => {
    /* The worst of the six: the board wrote the typed amount onto the card and
       closed the panel without looking at the answer, so a refused change
       showed the deal at its new value — and every total on the board with it —
       while the database held the old one. */
    const fn = board.slice(board.indexOf("async function handleSetValue"));
    const refused = fn.indexOf('"error" in result');
    const paints = fn.indexOf("setItems(");
    expect(refused, "the result is never inspected").toBeGreaterThan(-1);
    expect(paints, "the card is never updated").toBeGreaterThan(refused);
  });

  it("keeps the Add Deal form open when it was not added", () => {
    const fn = board.slice(board.indexOf("async function handleAdd"), board.indexOf("async function handleSetValue"));
    expect(fn).toMatch(/if \("error" in result\)/);
    expect(fn.indexOf("setAddOpen(null)")).toBeGreaterThan(fn.indexOf('"error" in result'));
  });

  it("answers in one shape", () => {
    expect(actions).toMatch(/export type DealResult/);
    expect(actions).toMatch(/export async function addDealAction\([^)]*\): Promise<DealResult>/);
  });
});

describe("meetings", () => {
  const view = read("../src/app/(app)/meetings/MeetingsView.tsx");
  const actions = read("../src/app/(app)/meetings/actions.ts");

  it("DOES NOT DESTROY NOTES IT FAILED TO SAVE", () => {
    /* Notes are typed once, from memory, straight after a meeting. This cleared
       the local draft and printed "Saved" whatever came back. */
    const fn = view.slice(view.indexOf("async function save()"));
    const refused = fn.indexOf('"error" in result');
    const cleared = fn.indexOf("clear();");
    expect(refused).toBeGreaterThan(-1);
    expect(cleared, "the draft is cleared before the answer is read").toBeGreaterThan(refused);
  });

  it("does not empty the booking form and claim the meeting is in the diary", () => {
    const fn = view.slice(view.indexOf("async function confirmMeeting"), view.indexOf("async function save()"));
    const refused = fn.indexOf('"error" in result');
    expect(refused).toBeGreaterThan(-1);
    expect(fn.indexOf('setName("")'), "the fields are emptied regardless").toBeGreaterThan(refused);
    expect(fn.indexOf("setJustAdded(true)")).toBeGreaterThan(refused);
  });

  it("answers in one shape", () => {
    expect(actions).toMatch(/export type MeetingResult/);
    for (const fn of ["addMeetingAction", "setMeetingNotesAction"]) {
      expect(actions).toMatch(new RegExp(`export async function ${fn}\\([\\s\\S]{0,120}Promise<MeetingResult>`));
    }
  });
});

describe("the two note forms", () => {
  const contacts = read("../src/app/(app)/contacts/ContactsView.tsx");
  const inbox = read("../src/app/(app)/inbox/InboxView.tsx");
  const actions = read("../src/app/(app)/contacts/actions.ts");

  it("KEEP THE NOTE WHEN IT WAS NOT SAVED", () => {
    /* Both emptied the box and said it had been filed on a timeline the reader
       would have to leave the screen to check. */
    for (const [name, src] of [["contacts", contacts], ["inbox", inbox]] as const) {
      expect(src, `${name} does not read the answer`).toMatch(/if \("error" in result\)/);
      expect(src, `${name} does not put the words back`).toMatch(/setKeptNote\(/);
      expect(src, `${name} does not show the reason`).toMatch(/defaultValue=\{keptNote\}/);
    }
  });

  it("answers in one shape", () => {
    expect(actions).toMatch(/export type NoteResult = \{ ok: true \} \| \{ error: string \}/);
    expect(actions).toMatch(/export async function addNoteAction\([^)]*\): Promise<NoteResult>/);
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

describe("what a view-only reader is offered", () => {
  const home = read("../src/app/(app)/page.tsx");
  const deals = read("../src/app/(app)/deals/DealsBoard.tsx");
  const leads = read("../src/app/(app)/leads/LeadCardsSection.tsx");
  const docs = read("../src/components/documents/DocumentLedgerView.tsx");
  const shell = read("../src/components/shell/AppShell.tsx");
  const permissions = read("../src/server/permissions.ts");

  /**
   * Making the refusal VISIBLE was half the fix; this is the other half.
   *
   * A viewer was offered every write control in the product — Add New Lead,
   * Add Deal, Compose Email, the per-column buttons, the drag — and every one
   * submitted and was refused. `permissions.ts` names that exact shape as the
   * thing to avoid: "a button that is visible, submits, and is refused".
   */
  it("IS NOT OFFERED THE PRIMARY CREATE BUTTONS", () => {
    expect(deals, "Add Deal is offered to a viewer").toMatch(/\{canWrite && \(\s*<button\s*onClick=\{\(\) => setAddOpen\(true\)\}/);
    expect(leads, "Add Lead is offered to a viewer").toMatch(/\{canWrite && \(\s*<button\s*onClick=\{\(\) => setModal\("new"\)\}/);
    expect(docs, "New quote/order is offered to a viewer").toMatch(/\{canWrite && projects\.length > 0 && \(/);
    expect(deals, "the per-column Add deal is offered to a viewer").toMatch(/\{canWrite && \(\s*<button\s*onClick=\{\(\) => setAddOpen\(stage\.id\)\}/);
  });

  it("is not told to drag cards it cannot move", () => {
    /* The instruction is only true for somebody who can act on it. */
    expect(deals).toMatch(/draggable=\{canWrite\}/);
    /* The sentence is built from the workspace's own words now — "Drag jobs"
       for a trades business — so what is pinned is that it still sits behind
       `canWrite`, rather than the wording itself. */
    expect(deals).toMatch(/canWrite\s*\n?\s*\?\s*`Drag \$\{words\.many\.toLowerCase\(\)\} across stages/);
  });

  it("keeps the places there are to LOOK", () => {
    /* Hiding the writes must not leave a viewer with an empty screen: the
       navigating quick actions are exactly what the role is for. */
    expect(home).toMatch(/label: "View Contacts", href: "\/contacts" \}/);
    expect(home).toMatch(/label: "Reports", href: "\/reports" \}/);
    /* …and the three that open a form carry the flag that hides them. */
    for (const label of ["Add New Lead", "Schedule Meeting", "Compose Email"]) {
      expect(home, `${label} is not marked as a write`).toMatch(
        new RegExp(`label: "${label}"[^}]*writes: true`)
      );
    }
  });

  it("DECIDES IT IN ONE PLACE, so a screen and the server cannot disagree", () => {
    /* The guard suite refuses an inline `role === "viewer"` anywhere else, and
       this is the named place it points at. */
    expect(permissions).toMatch(/export function canWrite\(role: string\): boolean/);
    expect(shell).toMatch(/<CanWriteProvider canWrite=\{canWrite\(user\.role\)\}>/);
  });

  it("is still REFUSED by the database, which is the part that matters", () => {
    /* Hiding a control is tidiness. A viewer who posts the action anyway meets
       a read-only transaction, and that is unchanged. */
    expect(read("../src/server/tenant.ts")).toMatch(/SET TRANSACTION READ ONLY/);
  });
});

describe("the ticks, the toggles and the deletes", () => {
  /**
   * The other half of this file.
   *
   * Everything above is a FORM: somebody filled it in, pressed a button, and
   * watched it close. The nine below are not forms — a tick, a status menu, a
   * delete behind a confirm — so the earlier pass never looked at them, and all
   * nine threw the server's answer away.
   *
   * They all failed the same way and for the same reason. `withCurrentTenant`
   * refuses a view-only reader with `return { error: … } as T`, and the cast is
   * what lets it do that for every action regardless of what the action
   * returns. So an action declared `Promise<void>` really does hand back a
   * refusal at run time while TypeScript insists there is nothing there — and a
   * caller inspecting it is writing code the compiler calls dead.
   *
   * The fix was to stop the type lying. See `server/write-result.ts`.
   */
  const writeResult = read("../src/server/write-result.ts");

  it("ANSWER IN A SHAPE THE COMPILER ADMITS EXISTS", () => {
    expect(writeResult).toMatch(/export type WriteResult = \{ ok: true \} \| \{ error: string \}/);
    const declared: [string, string][] = [
      ["../src/app/(app)/tasks/actions.ts", "setTodoDoneAction"],
      ["../src/app/(app)/inbox/actions.ts", "trashMessageAction"],
      ["../src/app/(app)/inbox/actions.ts", "restoreMessageAction"],
      ["../src/app/(app)/contacts/actions.ts", "deleteContactAction"],
      ["../src/app/(app)/voice-agents/actions.ts", "deleteCallAction"],
      ["../src/app/(app)/chat/actions.ts", "clearChatAction"],
    ];
    for (const [file, fn] of declared) {
      expect(read(file), `${fn} does not promise a readable answer`).toMatch(
        new RegExp(`export async function ${fn}\\([\\s\\S]{0,120}Promise<WriteResult>`)
      );
    }
    /* Meetings keeps its own result type, which already existed — the defect
       there was never the shape, it was that neither caller read it. */
    expect(read("../src/app/(app)/meetings/actions.ts")).toMatch(
      /export async function setMeetingOutcomeAction\([\s\S]{0,120}Promise<MeetingResult>/
    );
  });

  it("DO NOT TAKE THE ROW AWAY WHEN THE DELETE WAS REFUSED", () => {
    /* All three moved the selection on to the next record first, so a refused
       delete looked exactly like a successful one: the thing vanished from
       under the reader and came back on reload. */
    const cases: [string, string, string][] = [
      ["../src/app/(app)/contacts/ContactsView.tsx", "async function handleDelete", "setSelectedId("],
      ["../src/app/(app)/inbox/InboxView.tsx", "async function handleTrash", "setSelectedId("],
      ["../src/app/(app)/voice-agents/VoiceAgentConsole.tsx", "async function handleDelete", "setSelectedId("],
    ];
    for (const [file, fn, paints] of cases) {
      const body = read(file).slice(read(file).indexOf(fn));
      const checked = body.indexOf("refused(result)");
      expect(checked, `${file} ${fn} never inspects the answer`).toBeGreaterThan(-1);
      expect(body.indexOf(paints), `${file} ${fn} moves the selection regardless`).toBeGreaterThan(checked);
    }
  });

  it("SAY WHY, where the control that was pressed is", () => {
    for (const file of [
      "../src/app/(app)/contacts/ContactsView.tsx",
      "../src/app/(app)/inbox/InboxView.tsx",
      "../src/app/(app)/voice-agents/VoiceAgentConsole.tsx",
      "../src/app/(app)/meetings/MeetingsView.tsx",
      "../src/components/tasks/TaskItem.tsx",
    ]) {
      expect(read(file), `${file} never shows the reason`).toMatch(/role="alert"/);
    }
  });

  it("DO NOT EMPTY THE CHAT THE SERVER STILL HOLDS", () => {
    const reset = read("../src/app/(app)/chat/ChatView.tsx");
    const fn = reset.slice(reset.indexOf("async function reset()"));
    expect(fn.indexOf("setItems([])")).toBeGreaterThan(fn.indexOf("refused(result)"));
  });

  it("DO NOT LET A REFUSED TICK LOOK LIKE A GLITCH", () => {
    /* React reverts the optimistic value by itself when the transition ends, so
       this one never showed a wrong state for long — it showed NOTHING, and a
       checkbox that ticks and then quietly un-ticks reads as the product being
       broken rather than as an answer. */
    const item = read("../src/components/tasks/TaskItem.tsx");
    expect(item).toMatch(/if \(refused\(result\)\) setTickProblem\(result\.error\)/);
    expect(item).toMatch(/\{tickProblem \?\? deleteState\?\.error/);
  });

  it("DO NOT CLAIM AN OUTREACH WAS RECORDED WHEN IT WAS NOT", () => {
    /* `logOutreachAction` returns the activity row, or null, or a refusal — and
       a refusal is perfectly truthy, so a bare `if (!logged)` would have missed
       the one case this is about. */
    const view = read("../src/app/(app)/contacts/ContactsView.tsx");
    expect(view).toMatch(/refused\(logged\) \? logged\.error : logged \? null :/);
  });
});
