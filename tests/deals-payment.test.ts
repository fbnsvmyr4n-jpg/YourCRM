import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Recording a payment on a phone.
 *
 * Reported as slow, and it was — but not in the network. The board already
 * updates optimistically: `handlePayment` rewrites `items` before the server
 * answers, so the card moves the instant you submit. All of the slowness was
 * INPUT, and it was in three places at once.
 *
 * Counting the work for the commonest event in the app — "they paid the
 * invoice in full" — as it stood:
 *
 *   tap card -> scroll past the demo coaching -> tap field -> type 1 4 0 0 0
 *   -> dismiss or reach around the keyboard -> tap Record
 *
 * Eleven interactions to reproduce a number already printed one line above the
 * box. After: tap card, tap "Record $14,000". Two.
 */

const src = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/deals/DealsBoard.tsx", import.meta.url)),
  "utf8"
);

const modal = src.slice(src.indexOf("function DealModal"), src.indexOf("function PainPoints"));

/**
 * The same slice with every comment removed.
 *
 * Use this for anything that COUNTS or asserts an ABSENCE. Prose about the code
 * quotes the code, so `expect(...).not.toMatch(/autoFocus/)` failed against a
 * comment explaining why `autoFocus` was removed, and counting `sm:order-none`
 * found three where the markup has two. Both would have been false alarms; the
 * same mistake in the other direction is a test that passes on a comment while
 * the code says something else entirely.
 */
const code = modal.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the amount field", () => {
  it("starts at the whole outstanding balance", () => {
    /* It was a PLACEHOLDER showing exactly this figure — visible, and worth
       nothing, because a placeholder is not a value. The form submitted empty
       and the number had to be typed in by hand. */
    expect(modal).toMatch(/const \[amount, setAmount\] = useState\(String\(deal\.value\)\)/);
    expect(modal).toMatch(/value=\{amount\}/);
    expect(modal).not.toMatch(/placeholder=\{String\(deal\.value\)\}/);
  });

  it("holds the amount as text, so the field can be cleared", () => {
    /**
     * The reason it is a string. Held as a number, clearing the box to retype
     * it yields `0`, which renders as "0" and puts a character back the moment
     * you delete the last one — the field fights you for every part payment.
     */
    expect(modal).toMatch(/useState\(String\(deal\.value\)\)/);
    expect(modal).toMatch(/onChange=\{\(e\) => setAmount\(e\.target\.value\)\}/);
  });

  it("does not raise the keyboard over the button", () => {
    /* `autoFocus` on a field with nothing left to type is pure cost: the
       keyboard covers the control the tap is heading for. Measured on the
       phone, the submit button sat under it. */
    const field = code.slice(code.indexOf('name="amount"'), code.indexOf("</label>", code.indexOf('name="amount"')));
    expect(field).not.toMatch(/autoFocus/);
    /* The value form below it keeps its own conditional focus, which is a
       different field and still the right behaviour when it is the only one. */
    expect(code).toMatch(/autoFocus=\{!canPay\}/);
  });

  it("selects the figure on focus, so a part payment is one gesture too", () => {
    /* Prefilling helps the common case and would otherwise HURT the rare one:
       typing a different amount would mean deleting five digits around a caret
       dropped wherever the tap landed. Selecting on focus means typing
       replaces. */
    expect(modal).toMatch(/onFocus=\{\(e\) => e\.target\.select\(\)\}/);
  });
});

describe("what the button says", () => {
  it("names the amount it is about to record", () => {
    /* "Record payment" required trusting that the field above still held what
       you meant. The figure belongs where the decision is made. */
    expect(modal).toMatch(/`Record \$\{fullMoney\(entered\)\}`/);
  });

  it("falls back to a plain label rather than 'Record $0'", () => {
    /* The field can legitimately be empty mid-retype. A button offering to
       record nothing is worse than one that just says what it is. */
    expect(modal).toMatch(/entered > 0 \? `Record \$\{fullMoney\(entered\)\}` : "Record payment"/);
  });

  it("says whether this settles the deal or leaves a balance", () => {
    /**
     * The part people get wrong. A payment either closes the deal or splits it
     * into a won record and a remainder, and which one it did was previously
     * discoverable only afterwards, by noticing whether the card had vanished
     * from the board. Said in advance, in money.
     */
    expect(modal).toMatch(/const settles = entered === deal\.value && entered > 0/);
    expect(modal).toMatch(/settles\s*\?\s*"Closes the deal\."/);
    expect(modal).toMatch(/\$\{fullMoney\(deal\.value - entered\)\} stays open here\./);
  });

  it("cannot promise to record more than is outstanding", () => {
    /* `entered` is clamped, so a typed figure above the balance neither
       advertises itself on the button nor reads as settling something larger
       than the deal. The server clamps too; this keeps the label honest. */
    expect(modal).toMatch(/const entered = Math\.min\(deal\.value, Math\.max\(0, Number\(amount\) \|\| 0\)\)/);
  });
});

describe("the order of the modal", () => {
  it("puts money above the coaching on a phone", () => {
    /* You tapped the card to record a payment; the form should not be below
       four pain points and a referral prompt. */
    expect(modal).toMatch(/<div className="order-2 max-sm:-mb-3 sm:order-none">/);
    expect(modal).toMatch(/<div className="order-1 sm:order-none">/);
  });

  it("leaves the desktop modal exactly as it was", () => {
    /**
     * `sm:block` makes the wrapper a plain block container above `sm`, with the
     * same two children in the same source order and the same collapsed `mb-3`
     * margins. `sm:order-none` makes sure a stray `order` cannot reach it.
     */
    expect(modal).toMatch(/<div className="flex flex-col sm:block">/);
    const orders = code.match(/order-\d/g) ?? [];
    const resets = code.match(/sm:order-none/g) ?? [];
    expect(orders.length).toBeGreaterThan(0);
    expect(resets.length).toBe(orders.length);
  });

  it("cancels the trailing margin it would otherwise create", () => {
    /* Moved last, the coaching block's own `mb-3` becomes a gap under the final
       card. `-mb-3` is the exact cancel — both roots use `mb-3` — and it is
       `max-sm:` so it never applies where nothing moved. */
    expect(modal).toMatch(/max-sm:-mb-3/);
    const painRoot = src.slice(src.indexOf("function PainPoints"));
    expect(painRoot).toMatch(/<section className="mb-3 rounded-xl/);
  });
});
