import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../src/server/email";
import { shortenError } from "../src/server/notifications";

/**
 * What a person is told when their email did not go.
 *
 * Driving a real send in the Inbox produced this on screen, in a banner and
 * again under the subject line:
 *
 *   Saved, but it could not be sent: Resend returned 403 {"statusCode":403,
 *   "name":"validation_error","message":"You can only send testing emails to
 *   your own email address (fbnsvmyr4n@privaterelay.appleid.com). To send
 *   emails to other recipients, please veri
 *
 * Raw JSON, a vendor the user has never heard of, somebody's private email
 * address, and cut off mid-word. Every test was green: they checked that a
 * failure was recorded as a failure, and none of them read the sentence.
 *
 * So these read the sentence.
 */

const RESEND_403 =
  '{"statusCode":403,"name":"validation_error","message":"You can only send testing emails to your own email address (owner@example.com). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain."}';

let warned: string[] = [];

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
  warned = [];
  vi.spyOn(console, "warn").mockImplementation((line: string) => void warned.push(String(line)));
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function providerReplies(status: number, body: string) {
  vi.stubGlobal("fetch", async () => new Response(body, { status }));
}

const send = () =>
  sendEmail({ to: "someone@client.test", subject: "s", html: "<p>b</p>", text: "b" });

describe("the sentence a person reads", () => {
  it("is a sentence, not the provider's JSON", async () => {
    providerReplies(403, RESEND_403);
    const result = await send();

    expect(result.sent).toBe(false);
    expect(result.reason).not.toMatch(/[{}"]|statusCode|Resend/);
    expect(result.reason).toMatch(/test mode|domain/i);
  });

  it("does not put somebody's private email address on the screen", async () => {
    /* The provider quoted the account owner's own address back at us. It
       belongs in a log, not in a banner a client could be standing next to. */
    providerReplies(403, RESEND_403);
    const { reason } = await send();
    expect(reason).not.toContain("owner@example.com");
    expect(reason).not.toMatch(/@/);
  });

  it("survives the feed's shortener without being cut off mid-word", async () => {
    /* `shortenError` trims at 120 characters, and the old reason was long
       enough to be cut there as well as by the column. A sentence that reaches
       the reader in halves has not been written. */
    providerReplies(403, RESEND_403);
    const { reason } = await send();
    expect(shortenError(reason ?? "")).toBe(reason);
    expect(reason).not.toMatch(/…$/);
  });

  it.each([
    [401, "{}", /credential/i],
    [403, '{"message":"forbidden"}', /credential/i],
    [422, '{"message":"Invalid `to` field"}', /address/i],
    [429, "{}", /rate limit/i],
    [500, "oops", /trouble|tried again/i],
    [418, "{}", /error 418/],
  ])("explains a %i without leaking the body", async (status, body, shape) => {
    providerReplies(status as number, body as string);
    const { reason } = await send();
    expect(reason).toMatch(shape as RegExp);
    expect(reason).not.toMatch(/[{}"]/);
    expect((reason ?? "").length).toBeLessThanOrEqual(120);
  });

  it("keeps the provider's actual words for whoever has to diagnose it", async () => {
    /* The point of moving the raw text off the screen is not to lose it. A
       readable screen bought with a blind server is not a trade worth making. */
    providerReplies(403, RESEND_403);
    const result = await send();

    expect(result.detail).toContain("403");
    expect(warned.join("\n")).toContain("external.failed");
    expect(warned.join("\n")).toContain("403");
  });

  it("says email is not set up, rather than naming an environment variable", async () => {
    delete process.env.RESEND_API_KEY;
    const { reason, detail } = await send();
    expect(reason).not.toContain("RESEND_API_KEY");
    expect(reason).toMatch(/not set up/i);
    expect(detail).toContain("RESEND_API_KEY");
  });

  it("says it will be retried only when it actually will be", async () => {
    /* "it will be tried again" next to a job the queue has given up on is the
       same untruth in a friendlier voice. */
    providerReplies(500, "down");
    const transient = await send();
    expect(transient.permanent).toBeFalsy();
    expect(transient.reason).toMatch(/tried again/);

    providerReplies(422, '{"message":"Invalid `to` field"}');
    const permanent = await send();
    expect(permanent.permanent).toBe(true);
    expect(permanent.reason).not.toMatch(/tried again|shortly/);
  });
});
