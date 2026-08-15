import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Telephony seam for the Voice Agent.
 *
 * The console has always run on simulated calls. This is the path a real one
 * takes: a provider (Twilio) POSTs a webhook when someone dials the number, the
 * agent talks to them turn by turn, and when the call ends the conversation is
 * logged through exactly the same `logCall` → `processCall` automation the
 * simulator already uses. Nothing downstream changes.
 *
 * Connecting it is three environment variables and a webhook URL — no code
 * change. Until they are set, `telephonyConfigured()` is false and the UI says
 * calls are simulated rather than claiming a line nobody can dial.
 */

export type TelephonyStatus = {
  configured: boolean;
  /** The number callers dial, when one is connected. */
  number: string | null;
  /** Why it isn't live yet — shown in Settings so a bad setup is visible. */
  reason?: string;
};

export function telephonyStatus(): TelephonyStatus {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const number = process.env.TWILIO_PHONE_NUMBER?.trim();

  if (!sid || !token) {
    return { configured: false, number: null, reason: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set" };
  }
  if (!number) {
    return { configured: false, number: null, reason: "TWILIO_PHONE_NUMBER is not set" };
  }
  return { configured: true, number };
}

export function telephonyConfigured(): boolean {
  return telephonyStatus().configured;
}

/**
 * Verify a webhook really came from Twilio.
 *
 * Without this the endpoint is an open door: anyone who learns the URL can POST
 * a fabricated call and inject leads and meetings straight into the CRM. Twilio
 * signs each request with the auth token over the full URL plus the sorted body
 * parameters; recomputing that is the only thing that proves origin.
 *
 * Compared in constant time — a plain `===` on a signature leaks, through
 * timing, how much of a guess was correct.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null
): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!token || !signature) return false;

  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = createHmac("sha1", token).update(Buffer.from(payload, "utf8")).digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // (crude) oracle — check length first and always return, never throw.
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* TwiML                                                               */
/* ------------------------------------------------------------------ */

/** XML-escape. Caller speech ends up inside `<Say>`, so it must be escaped. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function twiml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

/**
 * Say something, then listen for the reply.
 *
 * `speechTimeout="auto"` lets Twilio decide the caller has finished rather than
 * cutting them off at a fixed interval — a person pausing mid-sentence should
 * not be treated as done. The trailing `<Redirect>` covers silence: without it
 * the call simply ends when nobody speaks, which sounds like being hung up on.
 */
export function sayAndGather(speech: string, action: string, hangUpOn?: string): string {
  const say = `<Say voice="Polly.Joanna-Neural">${esc(speech)}</Say>`;
  if (hangUpOn) return `${say}<Hangup/>`;

  return (
    `<Gather input="speech" speechTimeout="auto" action="${esc(action)}" method="POST">${say}</Gather>` +
    `<Say voice="Polly.Joanna-Neural">Sorry, I didn't catch that.</Say>` +
    `<Redirect method="POST">${esc(action)}</Redirect>`
  );
}

export function sayAndHangUp(speech: string): string {
  return `<Say voice="Polly.Joanna-Neural">${esc(speech)}</Say><Hangup/>`;
}
