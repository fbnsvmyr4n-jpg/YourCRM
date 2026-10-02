import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What the public pages promise a stranger.
 *
 * These are the only screens in the product seen by somebody who is not a
 * customer of ours and has no way to ask what happened. A sentence that is not
 * true here costs a booking or a payment, and the person it fails has nobody
 * to complain to — they simply assume the business is not serious.
 *
 * Two were found on 2026-09-30 by booking a slot and opening a pay link on a
 * deployment configured the way production actually is:
 *
 *   - the booking confirmation said "a confirmation will be emailed to you"
 *     whatever the deployment could send, and `RESEND_API_KEY` is unset in
 *     production — so the one thing telling a stranger their booking worked
 *     was a promise of an email that would never arrive;
 *   - the pay page said "use the payment details below" when the workspace had
 *     not filled any in, sending somebody who could not pay by card to a blank
 *     space with no way to pay at all.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const bookingView = read("../src/app/(public)/book/[slug]/BookingView.tsx");
const bookingPage = read("../src/app/(public)/book/[slug]/page.tsx");
const pay = read("../src/server/pay/pay.ts");

describe("a public page promises only what this deployment can do", () => {
  it("OFFERS A CONFIRMATION EMAIL ONLY WHERE ONE CAN BE SENT", () => {
    const at = bookingView.indexOf("A confirmation will be emailed to you");
    expect(at, "the confirmation copy has moved — update this test").toBeGreaterThan(-1);
    expect(
      bookingView.slice(Math.max(0, at - 260), at),
      "the promise is made without checking email is configured"
    ).toMatch(/emailWorks/);
  });

  it("still tells somebody their booking landed when email is off", () => {
    /* The absence of a promise is not the same as saying nothing: a stranger
       needs to know the slot is theirs. */
    expect(bookingView).toMatch(/Your time is held/);
  });

  it("reads whether email works from the environment, not from a flag somebody set", () => {
    expect(bookingPage).toMatch(/emailWorks=\{emailConfigured\(\)\}/);
  });

  it("POINTS AT PAYMENT DETAILS ONLY WHEN THERE ARE SOME", () => {
    expect(pay).toMatch(/invoice\.payTo[\s\S]{0,120}Use the payment details below/);
    /* And says something useful when there are not. */
    expect(pay).toMatch(/Contact \$\{link\.workspaceName\} to arrange payment/);
  });

  it("never hard-codes the old unconditional sentences", () => {
    /* Both survived review once by reading perfectly well in the happy case. */
    expect(pay).not.toMatch(/does not take card payments online\. Use the payment details below\./);
    expect(pay).not.toMatch(/not available in \$\{currency\}\. Use the payment details below\./);
  });
});

describe("what counts as email being configured", () => {
  const email = read("../src/server/email.ts");
  const health = read("../src/app/api/health/route.ts");

  it("A KEY ALONE IS NOT ENOUGH — the shared sender reaches only the account holder", () => {
    /*
       The booking audit walked straight into this. With `RESEND_API_KEY` set
       and `EMAIL_FROM` unset, `fromAddress()` falls back to Resend's shared
       sender, which delivers only to the account holder — so the product
       believed email worked, told a stranger "a confirmation will be emailed to
       you", and the job died in the outbox saying the domain was not verified.

       Not a corner case: key first, domain verified afterwards is the order
       anybody sets this up in, and it is the state this repository was in when
       the audit found it.
    */
    expect(email).toMatch(/RESEND_API_KEY\?\.trim\(\) && process\.env\.EMAIL_FROM\?\.trim\(\)/);
  });

  it("still ATTEMPTS a send with whatever it has, and reports what came back", () => {
    /* The stricter definition governs promises and status lines, not whether
       the queue tries: a job that never tries can never report a real reason,
       and "it would only reach you" is a reason worth hearing. */
    const send = email.slice(email.indexOf("export async function sendEmail"));
    expect(send).toMatch(/const key = process\.env\.RESEND_API_KEY\?\.trim\(\)/);
    expect(send).not.toMatch(/emailConfigured\(\)/);
  });

  it("says WHICH half is missing, because the two are set at different times", () => {
    expect(health).toMatch(/RESEND_API_KEY unset/);
    expect(health).toMatch(/EMAIL_FROM is not/);
  });
});
