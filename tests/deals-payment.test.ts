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
    expect(code).toMatch(/autoFocus=\{!payable\}/);
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

describe("paid in full, without opening anything", () => {
  /**
   * Reported after the two-tap version shipped: still confusing to new users.
   *
   * Two taps was the right count for the wrong flow. Tapping the card opens a
   * PANEL — a paragraph about what happens to the money, a number in a box, a
   * line about what the amount will do, a button. A new user reads that as a
   * decision they have to get right, and it is not a decision at all: the
   * commonest thing that happens to a deal is that the invoice was paid, in
   * full, for the figure already printed on the card.
   *
   * So the whole panel is gone from that path. The card carries the amount and
   * a button naming it, and the panel stays where it belongs — the part payment,
   * which genuinely is a decision about an amount.
   */
  it("puts the amount on the card as the action", () => {
    expect(src).toMatch(/Paid \{money\(deal\.value\)\}/);
    /* Named, so the tap is confirmed by reading rather than by a dialog after
       the fact — and by watching the card cross the board. */
    expect(src).toMatch(/onPaidInFull\(\);/);
    /* The card itself opens the panel; this must not. */
    expect(src).toMatch(/e\.stopPropagation\(\);\s*\n\s*onPaidInFull\(\);/);
  });

  it("shows it only where money can actually be taken", () => {
    /* The same rule the server enforces — Discovery or Demo, and a figure to
       pay. A button offering to close a deal the server will refuse is worse
       than no button. */
    expect(src).toMatch(/\{canPay\(deal\) && \(/);
    expect(src).toMatch(
      /const canPay = \(d: Deal\) => \(d\.stage === "demo" \|\| d\.stage === "discovery"\) && d\.value > 0;/
    );
    /* Stated once. The panel asks the same question, and two copies of a rule
       about money is one copy too many. */
    expect(src).toMatch(/const payable = canPay\(deal\);/);
  });

  it("sends the whole outstanding figure, not a typed one", () => {
    expect(src).toMatch(/formData\.set\("amount", String\(deal\.value\)\)/);
  });
});

describe("the way back", () => {
  /**
   * What makes the tap above defensible.
   *
   * Recording money closes a deal, moves it between columns and changes what
   * Reports says the business earned. Doing all that on one unconfirmed tap is
   * only reasonable if it can be taken back — otherwise the honest design is a
   * confirmation dialog, which is the thing being removed.
   */
  it("offers an undo naming the amount and the deal", () => {
    expect(src).toMatch(/label: `\$\{fullMoney\(paid\)\} recorded against \$\{deal\.title\}`/);
    expect(src).toMatch(/<Undo2 className="h-3\.5 w-3\.5" \/> Undo/);
    /* The server's id, not the local stand-in the board draws with — the undo
       has to name a real record. */
    expect(src).toMatch(/wonDealId: res\.wonDealId/);
    /* Cents, which is what the money is stored in and what the server checks. */
    expect(src).toMatch(/amountCents: Math\.round\(paid \* 100\)/);
  });

  it("waits for the server before putting the board back", () => {
    /* Reverting first and finding out afterwards is how a board ends up
       describing something that never happened. */
    expect(src).toMatch(/if \(!res\?\.error\) setItems\(revert\);/);
  });

  it("puts the card back in its own slot, not at the top", () => {
    /**
     * Reported after the first version shipped. Undo restored the deal, the
     * money and the stage correctly — and dropped the card at the top of its
     * column. On a phone, with two or three cards on screen at a time, a card
     * that reappears somewhere else does not read as restored; it reads as
     * lost, and the reader scrolls the column hunting for it.
     *
     * Anchored to the card it followed rather than to an index, because an
     * index goes stale the moment anything else on the board moves. The
     * arithmetic itself is proved in `restore-position.test.ts`; what this
     * checks is that the board remembers the right thing and hands it over.
     */
    expect(src).toMatch(/const at = items\.findIndex\(\(d\) => d\.id === deal\.id\);/);
    expect(src).toMatch(/const followedId = at > 0 \? items\[at - 1\]\.id : null;/);
    expect(src).toMatch(/return restoreAt\(withoutMoney, deal, \(d\) => d\.id, followedId, at\);/);
    /* A part payment never removed the card, so there is no position to put
       back — only the figure on it. */
    expect(src).toMatch(
      /if \(withoutMoney\.some\(\(d\) => d\.id === deal\.id\)\) \{\s*\n\s*return withoutMoney\.map/
    );
  });

  it("reverses only what the payment touched", () => {
    /**
     * Not a snapshot of the board taken before the payment. A snapshot would
     * also undo anything done while the bar was on screen — drag a card in
     * those few seconds and it would silently jump back.
     *
     * Which of the two branches ran decides the inverse: money that CREATED a
     * won card means the card goes; money that topped up an existing one means
     * the figure comes down.
     */
    expect(src).toMatch(/const existingWon = items\.find\(\(d\) => d\.splitId === splitId && isWon\(d\)\);/);
    expect(src).toMatch(
      /revert: \(prev\) => \{\s*\n\s*const withoutMoney = existingWon\s*\n\s*\? prev\.map/
    );
    expect(src).toMatch(/: prev\.filter\(\(d\) => d\.id !== wonLocalId\);/);
  });

  it("says so and changes nothing when the server refuses", () => {
    /* No undo offered for something that did not happen. */
    expect(src).toMatch(/if \(err\) setFlash\(\{ wonDealId: null,.*failed: true \}\);/);
    expect(src).toMatch(/\{flash\.wonDealId \? \(/);
  });
});
