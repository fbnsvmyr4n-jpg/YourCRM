import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasContent, EMPTY_DRAFT } from "../src/lib/use-draft";

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const view = src("../src/app/(app)/inbox/InboxView.tsx");
/* Comments below quote the markup they replaced, so absence checks run against
   the code rather than the prose describing it. */
const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const draftLib = src("../src/lib/use-draft.ts");
const swipe = src("../src/components/ui/SwipeToDelete.tsx");
const field = src("../src/components/ui/PersonField.tsx");
const repo = src("../src/server/repos/inbox.ts");
const page = src("../src/app/(app)/inbox/page.tsx");

describe("a message survives the composer closing", () => {
  it("treats whitespace as nothing written", () => {
    expect(hasContent(EMPTY_DRAFT)).toBe(false);
    expect(hasContent({ to: "   ", subject: "\n", body: " " })).toBe(false);
    expect(hasContent({ ...EMPTY_DRAFT, body: "half a sentence" })).toBe(true);
    expect(hasContent({ ...EMPTY_DRAFT, to: "kobus@steynsteel.co" })).toBe(true);
  });

  it("keeps the whole message, not only the recipient", () => {
    /* The report was losing the message. Saving just the address would have
       kept the easiest field to retype and thrown away the hardest. */
    expect(code).toMatch(/value=\{draft\.subject\}/);
    expect(code).toMatch(/value=\{draft\.body\}/);
    expect(code).toMatch(/save\(\{ \.\.\.draft, to: v \}\)/);
  });

  it("saves on every keystroke rather than on a polite close", () => {
    /**
     * A draft written only when the box is dismissed does not survive the two
     * ways work actually vanishes: a reload, and a tab that never closes
     * politely. Verified by reloading the page with a part-written mail and
     * reopening it — subject and body both came back.
     */
    expect(draftLib).toMatch(/window\.localStorage\.setItem\(key, JSON\.stringify\(next\)\)/);
    expect(code).toMatch(/onChange=\{\(e\) => save\(\{ \.\.\.draft, subject: e\.target\.value \}\)\}/);
  });

  it("clears only once the send has gone through", () => {
    /* Clearing on submit would throw the message away on the one occasion it
       matters most — a send that failed. */
    expect(code).toMatch(/await onSubmit\(formData\);\s*\n\s*clear\(\);/);
  });

  it("says the box is not throwing the message away", () => {
    /* "Cancel" reads as discard. It keeps the draft, so it says so, and the
       only way to actually discard is asked for by name. */
    expect(code).toMatch(/hasContent\(draft\) \? "Save & Close" : "Cancel"/);
    expect(code).toMatch(/Discard draft/);
  });

  it("says a draft is waiting, on both entry points", () => {
    // Desktop has room for the word; the 36px round button gets a dot, and a
    // label that says it for anyone who cannot see the dot.
    expect(code).toMatch(/draftWaiting \? "Continue Draft" : "Create New Email"/);
    expect(code).toMatch(/aria-label=\{draftWaiting \? "Continue your draft email" : "Create new email"\}/);
  });

  it("survives storage that throws rather than returning null", () => {
    /* Private windows and browsers set to block site data throw on access. A
       composer that cannot save a draft is still a composer. */
    const guarded = draftLib.match(/catch \{/g) ?? [];
    expect(guarded.length).toBeGreaterThanOrEqual(3);
  });

  it("never lets a stored value reach an input as a non-string", () => {
    /* Anything could be under this key — an older build, another tab, someone
       with devtools open. Checked field by field rather than cast. */
    expect(draftLib).toMatch(/typeof d\.to === "string" \? d\.to : ""/);
    expect(draftLib).toMatch(/typeof d\.body === "string" \? d\.body : ""/);
  });

  it("returns the same snapshot object while the stored text is unchanged", () => {
    /**
     * `useSyncExternalStore` compares snapshots by identity. Parsing afresh on
     * every call reports a change on every render and loops forever.
     */
    expect(draftLib).toMatch(/if \(raw === cachedRaw\) return cachedDraft/);
  });
});

describe("swiping a message away", () => {
  it("leaves the mouse alone entirely", () => {
    /* The desktop list is not to change. A mouse press is ignored outright
       rather than styled around, so a click on a row is the click it was. */
    expect(swipe).toMatch(/if \(e\.pointerType === "mouse"\) return;/);
  });

  it("does not fight the list's own scrolling", () => {
    /**
     * The list scrolls far more often than a row is deleted. The gesture waits
     * for 10px of travel and only claims it when sideways movement is clearly
     * winning; vertical panning stays the browser's.
     */
    expect(swipe).toMatch(/if \(Math\.abs\(moveX\) < 10 && Math\.abs\(moveY\) < 10\) return;/);
    expect(swipe).toMatch(/horizontal\.current = Math\.abs\(moveX\) > Math\.abs\(moveY\)/);
    expect(swipe).toMatch(/touchAction: "pan-y"/);
  });

  it("decides on release from a value that is actually current", () => {
    /**
     * Reading `dx` there reads the last COMMITTED render, so a quick flick —
     * the final move and the release in one frame — released with 0 and snapped
     * shut. The faster the gesture, the less likely it was to work. Caught by
     * driving the swipe from a script, where every event lands in one tick and
     * it failed every time; after the fix the same flick settles at -84.
     */
    expect(swipe).toMatch(/const settled = dxRef\.current <= -COMMIT/);
    expect(swipe).not.toMatch(/const settled = dx <= -COMMIT/);
  });

  it("keeps receiving the gesture as the row moves out from under the finger", () => {
    /**
     * Without pointer capture, pointer events go to whatever is under the
     * finger at the time — and this row is MOVING under the finger, so
     * `pointerup` can land on a different element and never arrive here. The
     * drag then never ends: `dragging` stays true, which keeps the bin on
     * screen, while `open` is never set.
     *
     * Seen on an iPhone recording. The row showed the bin and the next tap
     * opened the message, with no confirmation in between — the row looked
     * swiped and behaved as though it was not.
     */
    expect(swipe).toMatch(/setPointerCapture\?\.\(e\.pointerId\)/);
    expect(swipe).toMatch(/releasePointerCapture\(e\.pointerId\)/);
  });

  it("never leaves a bin over a row that still opens the message", () => {
    /**
     * The second half of the same defect, and the one that made it harmful.
     * Gating the row's guard on `open` alone meant a drag that never ended
     * showed a delete button over a row whose tap still opened the message.
     * Whenever the bin is visible for ANY reason, tapping the row closes it.
     *
     * Reproduced by dispatching a swipe with no `pointerup` at all: the bin
     * appears and the guard now appears with it.
     */
    const bin = swipe.indexOf("{(dragging || open) && (");
    const guard = swipe.indexOf("{(dragging || open) && (", bin + 1);
    expect(bin).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(bin);
    expect(swipe).not.toMatch(/\{open && \(\s*\n\s*<button\s*\n\s*type="button"\s*\n\s*aria-label="Close delete"/);
  });

  it("makes the whole red strip the target, not an icon floating in it", () => {
    /* A tap that lands in the red area but beside the icon should still delete.
       Verified 10px inside the strip, well off the icon: it hit the bin and
       raised the confirmation rather than opening the message. */
    expect(swipe).toMatch(/aria-label=\{`Delete \$\{label\}`\}[\s\S]{0,240}?absolute inset-y-0 right-0 grid w-\[84px\]/);
  });

  it("shows the bin only on the row being swiped", () => {
    /**
     * Message rows have no background of their own, so a bin mounted behind
     * every row showed THROUGH all of them — the first run put a red bin on
     * every message in the list, including untouched ones.
     */
    expect(swipe).toMatch(/\{\(dragging \|\| open\) && \(/);
  });

  it("follows the finger, and only animates once let go", () => {
    // A transition during the drag is what makes a swipe feel like it is
    // lagging behind the hand.
    expect(swipe).toMatch(/!dragging && "transition-transform/);
  });

  it("asks before deleting, and says where the message goes", () => {
    /* A swipe is easy to make by accident. "Delete" alone reads as gone
       forever, and this is not that. */
    expect(code).toMatch(/Delete this message\?/);
    expect(code).toMatch(/moves to Trash, where it stays for 7 days/);
    expect(code).toMatch(/Keep it/);
  });

  it("offers no swipe on something already deleted", () => {
    // Trash has Restore. Swiping to delete a deleted message is a gesture with
    // nothing behind it.
    expect(code).toMatch(/if \(m\.trashed\) return <div key=\{m\.id\}>\{row\}<\/div>;/);
  });
});

describe("the bin empties itself", () => {
  it("removes what was deleted more than seven days ago", () => {
    expect(repo).toMatch(/export const TRASH_DAYS = 7/);
    expect(repo).toMatch(/deleted_at < now\(\) - \(\$2::int \* INTERVAL '1 day'\)/);
  });

  it("can only ever reach this tenant's own already-deleted mail", () => {
    /**
     * The one destructive query in this file, so its `WHERE` is the whole
     * safety argument: scoped to the account, and to rows the account itself
     * put in the bin. The cutoff is a bound parameter, and the interval is
     * computed by the database against `now()` rather than by whatever the web
     * server believes the time to be.
     */
    const at = repo.indexOf("export async function purgeExpiredMessages");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = repo.slice(at, repo.indexOf("\n}", at));
    expect(body).toMatch(/WHERE sub_account_id = \$1/);
    expect(body).toMatch(/AND deleted_at IS NOT NULL/);
    expect(body).not.toMatch(/\$\{/);
  });

  it("runs before the page reads, not after", () => {
    /* Otherwise something expired is listed once and then vanishes on the next
       load, which reads as the app losing mail. */
    const purge = page.indexOf("await purgeExpiredMessages(q)");
    const read = page.indexOf("await listMessages(q");
    expect(purge).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(purge);
  });

  it("tells the reader, in the folder it applies to", () => {
    // So the 7 days promised in the confirmation is a promise seen to be kept.
    expect(code).toMatch(/Deleted messages are removed for good after 7 days\./);
    expect(code).toMatch(/filter === "Trash" && list\.length > 0/);
  });
});

describe("the suggestion list settles rather than snaps", () => {
  it("arrives with a short movement, and none for reduced motion", () => {
    const css = src("../src/app/globals.css");
    expect(css).toMatch(/@keyframes popoverIn\b/);
    expect(css).toMatch(/@keyframes popoverInUp/);
    const at = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .popover-in,");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(css.slice(at, at + 160)).toMatch(/animation: none/);
  });

  it("rises from the field whichever way it opened", () => {
    // Opening upward, dropping from above would point at nothing.
    expect(field).toMatch(/pos\.bottom !== undefined \? "popover-in-up" : "popover-in"/);
  });

  it("keeps the caret in the field when a suggestion is pressed", () => {
    /**
     * Without it, pressing a suggestion blurs the input first: on iOS the
     * keyboard starts closing, the page reflows under the finger, and the list
     * moves out from under the tap aimed at it. The pick still happens on
     * click.
     */
    expect(field).toMatch(/onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/);
  });

  it("cannot select past the end of a list that just narrowed", () => {
    /* The list shrinks as more is typed, and a highlight left pointing past the
       end would hand `undefined` to `choose`. */
    expect(field).toMatch(/const active = Math\.min\(highlight, Math\.max\(0, matches\.length - 1\)\)/);
    expect(field).toMatch(/choose\(matches\[active\]\)/);
    expect(field).not.toMatch(/choose\(matches\[highlight\]\)/);
  });

  it("keeps the highlighted row in view when the list scrolls", () => {
    // It has a max height, so arrowing past the bottom edge would otherwise
    // move a selection nobody can see.
    expect(field).toMatch(/scrollIntoView\(\{ block: "nearest" \}\)/);
    expect(field).toMatch(/data-idx=\{i\}/);
  });
});
