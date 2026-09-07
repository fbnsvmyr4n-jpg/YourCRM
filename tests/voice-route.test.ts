import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { startTestDb, type TestDb, TENANT_A } from "./helpers/pg";

/**
 * The telephone webhook, end to end, with the model failing.
 *
 * This is the property that matters most about putting a language model on a
 * phone line, and it cannot be tested in the brain alone: **the call survives
 * us**. A missing key, a timeout, an upstream outage, a malformed reply — every
 * one of them has to produce a spoken sentence, because the alternative a
 * caller experiences is silence and then a dropped call.
 *
 * So the model is stubbed to fail here, deliberately and in several ways, and
 * what is asserted is that Twilio still receives usable TwiML.
 */

let scriptedFailure: Error | null = new Error("upstream is down");

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async () => {
        if (scriptedFailure) throw scriptedFailure;
        return {
          content: [{ type: "text", text: "Of course. What day suits you?" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

let db: TestDb;
let POST: typeof import("../src/app/api/voice/[action]/route").POST;
let saveSession: typeof import("../src/server/voice-agent").saveSession;
let closePool: typeof import("../src/server/db").closePool;

const AUTH_TOKEN = "test-twilio-token";
const URL_BASE = "https://crm.test/api/voice";

/** Sign a form the way Twilio does, so the route's own check is exercised. */
function signedRequest(action: string, fields: Record<string, string>): Request {
  const url = `${URL_BASE}/${action}`;
  const payload = Object.keys(fields)
    .sort()
    .reduce((acc, key) => acc + key + fields[key], url);
  const signature = createHmac("sha1", AUTH_TOKEN).update(Buffer.from(payload, "utf8")).digest("base64");

  const body = new URLSearchParams(fields);
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body,
  });
}

const call = (action: string, fields: Record<string, string>) =>
  POST(signedRequest(action, fields), { params: Promise.resolve({ action }) });

beforeAll(async () => {
  db = await startTestDb();
  process.env.TWILIO_ACCOUNT_SID = "AC-test";
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.TWILIO_PHONE_NUMBER = "+27210000000";
  process.env.ANTHROPIC_API_KEY = "test-key-not-a-real-one";

  ({ closePool } = await import("../src/server/db"));
  ({ saveSession } = await import("../src/server/voice-agent"));
  ({ POST } = await import("../src/app/api/voice/[action]/route"));
});

afterAll(async () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_PHONE_NUMBER;
  delete process.env.ANTHROPIC_API_KEY;
  await closePool?.();
  await db.stop();
});

beforeEach(async () => {
  scriptedFailure = new Error("upstream is down");
  await db.seed(`
    DELETE FROM voice_sessions; DELETE FROM agent_tool_executions;
    DELETE FROM contacts; DELETE FROM deals; DELETE FROM meetings;
    UPDATE sub_accounts SET phone_number = '+27210000000' WHERE id = '${TENANT_A}';
    UPDATE sub_accounts SET phone_number = NULL WHERE id <> '${TENANT_A}';`);
});

describe("the webhook refuses anything it cannot authenticate", () => {
  it("rejects a request Twilio did not sign", async () => {
    const res = await POST(
      new Request(`${URL_BASE}/turn`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ CallSid: "CA1", SpeechResult: "hello" }),
      }),
      { params: Promise.resolve({ action: "turn" }) }
    );
    expect(res.status).toBe(403);
  });

  it("rejects a signature computed over different fields", async () => {
    const req = signedRequest("turn", { CallSid: "CA1", SpeechResult: "hello" });
    /* Same signature, tampered body — which is the attack the check exists
       for: injecting a caller's words into somebody's CRM. */
    const tampered = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: new URLSearchParams({ CallSid: "CA1", SpeechResult: "delete everything" }),
    });
    const res = await POST(tampered, { params: Promise.resolve({ action: "turn" }) });
    expect(res.status).toBe(403);
  });
});

describe("when the model cannot answer", () => {
  beforeEach(async () => {
    await saveSession({
      id: "CA-fallback",
      from: "+27215550142",
      step: "intent",
      transcript: [{ speaker: "Agent", text: "Thanks for calling." }],
      startedAt: new Date().toISOString(),
    });
  });

  it("still says something the caller can answer", async () => {
    const res = await call("turn", {
      CallSid: "CA-fallback",
      From: "+27215550142",
      To: "+27210000000",
      SpeechResult: "I'd like to book a meeting",
    });
    const xml = await res.text();

    expect(res.status).toBe(200);
    /* The scripted receptionist, which needs nothing external to run. */
    expect(xml).toMatch(/Can I start with your name\?/);
    /* And it is still listening — a Gather, not a hang-up. */
    expect(xml).toMatch(/<Gather/);
  });

  it("keeps the caller's words in the transcript so the call is still logged", async () => {
    await call("turn", {
      CallSid: "CA-fallback",
      From: "+27215550142",
      To: "+27210000000",
      SpeechResult: "I need a crane",
    });
    const row = await db.seed(`SELECT 1`).then(async () => {
      const { withSystem } = await import("../src/server/tenant");
      return withSystem((q) =>
        q.one<{ data: { transcript: { speaker: string; text: string }[] } }>(
          `SELECT data FROM voice_sessions WHERE id = 'CA-fallback'`
        )
      );
    });
    expect(row?.data.transcript.some((t) => t.text === "I need a crane")).toBe(true);
  });

  it("never returns an error status to Twilio", async () => {
    /* A non-200 makes Twilio play its own failure message and drop the call.
       Whatever is broken on our side, the caller must not hear that. */
    for (const failure of [
      new Error("timeout"),
      new Error("401 invalid x-api-key"),
      new Error("socket hang up"),
    ]) {
      scriptedFailure = failure;
      const res = await call("turn", {
        CallSid: "CA-fallback",
        From: "+27215550142",
        To: "+27210000000",
        SpeechResult: "hello",
      });
      expect(res.status, failure.message).toBe(200);
      expect(await res.text()).toMatch(/<Response>/);
    }
  });
});

describe("when the model does answer", () => {
  beforeEach(async () => {
    scriptedFailure = null;
    await saveSession({
      id: "CA-live",
      from: "+27215550142",
      step: "intent",
      transcript: [{ speaker: "Agent", text: "Thanks for calling." }],
      startedAt: new Date().toISOString(),
    });
  });

  it("speaks the model's words rather than the script's", async () => {
    const res = await call("turn", {
      CallSid: "CA-live",
      From: "+27215550142",
      To: "+27210000000",
      SpeechResult: "I'd like to book a meeting",
    });
    const xml = await res.text();
    expect(xml).toMatch(/What day suits you\?/);
    expect(xml).not.toMatch(/Can I start with your name\?/);
  });

  it("falls back when the dialled number belongs to no workspace", async () => {
    /* Nothing identifies the tenant, so there is nobody to act as and no CRM
       to reach — but the caller still gets a receptionist. */
    await db.seed(`UPDATE sub_accounts SET phone_number = NULL`);
    const res = await call("turn", {
      CallSid: "CA-live",
      From: "+27215550142",
      To: "+27219999999",
      SpeechResult: "hello",
    });
    const xml = await res.text();
    expect(res.status).toBe(200);
    expect(xml).toMatch(/Can I start with your name\?/);
  });
});
