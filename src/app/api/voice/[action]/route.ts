import { logCall } from "@/server/repos/calls";
import { getSettings } from "@/server/repos/settings";
import { processCall } from "@/server/process-call";
import { tenantForDialledNumber } from "@/server/telephony-tenant";
import { withTenant } from "@/server/tenant";
import { recordUsage, voiceCostMicros } from "@/server/usage";
import { wallClockToInstant } from "@/lib/zoned";
import { sayAndGather, sayAndHangUp, telephonyConfigured, twiml, verifyTwilioSignature } from "@/server/telephony";
import {
  GREETING,
  callFromSession,
  endSession,
  getSession,
  nextTurn,
  saveSession,
  type VoiceSession,
} from "@/server/voice-agent";

/**
 * Twilio webhooks for the Voice Agent.
 *
 *   POST /api/voice/incoming  — a call arrives; greet and start listening
 *   POST /api/voice/turn      — the caller said something; reply
 *   POST /api/voice/status    — the call ended; log it and run the automation
 *
 * Point the Twilio number's "A call comes in" at `/api/voice/incoming` and its
 * status callback at `/api/voice/status`. The agent answers whenever Twilio
 * rings it, which is what makes it 24/7 — there are no office hours in this
 * path to fall outside of.
 *
 * Every request is signature-checked. These are public URLs, and the automation
 * behind them writes leads and meetings, so an unverified POST would let anyone
 * inject records into the CRM.
 */

export const dynamic = "force-dynamic";

/** The URL Twilio signed. Behind a proxy the forwarded host is the real one. */
function signedUrl(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}${url.pathname}`;
}

export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;

  // Refuse to answer at all until a line is actually connected. Responding
  // with TwiML while unconfigured would mean an unauthenticated endpoint that
  // writes to the CRM sitting open on every deployment.
  if (!telephonyConfigured()) {
    return new Response("Telephony is not configured", { status: 503 });
  }

  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") params[k] = v;

  if (!verifyTwilioSignature(signedUrl(req), params, req.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }

  const callSid = params.CallSid;
  if (!callSid) return new Response("Missing CallSid", { status: 400 });

  switch (action) {
    case "incoming": {
      const session: VoiceSession = {
        id: callSid,
        from: params.From || "Unknown",
        step: "intent",
        transcript: [{ speaker: "Agent", text: GREETING }],
        startedAt: new Date().toISOString(),
      };
      await saveSession(session);
      return twiml(sayAndGather(GREETING, "/api/voice/turn"));
    }

    case "turn": {
      const session = await getSession(callSid);
      // A turn for a call we never greeted (a retry after a restart, say)
      // shouldn't crash the call — start it over rather than dropping it.
      if (!session) {
        const fresh: VoiceSession = {
          id: callSid,
          from: params.From || "Unknown",
          step: "intent",
          transcript: [{ speaker: "Agent", text: GREETING }],
          startedAt: new Date().toISOString(),
        };
        await saveSession(fresh);
        return twiml(sayAndGather(GREETING, "/api/voice/turn"));
      }

      const { session: updated, say, done } = nextTurn(session, params.SpeechResult ?? "");
      await saveSession(updated);
      return twiml(done ? sayAndHangUp(say) : sayAndGather(say, "/api/voice/turn"));
    }

    case "status": {
      // Twilio sends several status callbacks per call; only the final one
      // should produce records, or one conversation becomes several leads.
      if (params.CallStatus !== "completed") return new Response(null, { status: 204 });

      const session = await getSession(callSid);
      if (!session) return new Response(null, { status: 204 });

      /**
       * Whose CRM does this call belong to?
       *
       * Nothing in a Twilio callback answers that — there is no session, and
       * the URL is public. The dialled number is the only signal, so it is what
       * resolves the tenant. When it resolves to nothing the call is dropped
       * rather than written somewhere: records landing in the wrong customer's
       * account is a cross-tenant leak that arrives as a stranger's caller
       * appearing in your contacts.
       */
      const ctx = await tenantForDialledNumber(params.To ?? null);
      if (!ctx) {
        await endSession(callSid);
        return new Response(null, { status: 204 });
      }

      const duration = Number.parseInt(params.CallDuration ?? "", 10);
      const durationSec = Number.isFinite(duration) && duration > 0 ? duration : 60;
      const captured = callFromSession(session, durationSec);

      await withTenant(ctx, async (q) => {
        const { timeZone } = await getSettings(q);

        // The caller asked for a relative slot ("tomorrow at ten"). Resolved to
        // an instant here, at capture, in the business's own zone — a label
        // stored instead would stop being true the day after the call.
        const day = new Date();
        if (captured.requestedWhen === "Tomorrow") day.setUTCDate(day.getUTCDate() + 1);
        if (captured.requestedWhen === "This Week") day.setUTCDate(day.getUTCDate() + 2);
        const requestedAt = captured.requestedWhen
          ? wallClockToInstant(day.toISOString().slice(0, 10), captured.requestedTime ?? "10:00", timeZone)
          : null;

        /**
         * Metered before the call is written, from the carrier's own duration.
         *
         * Telephony is the other half of the margin question: inbound minutes
         * are billed to us per minute while the plans sell the feature flat.
         * Recorded per workspace, because an agency reselling to its clients
         * needs to know WHICH client is generating the cost — that is also the
         * input rebilling will need.
         */
        await recordUsage(q, {
          kind: "voice_minute",
          // Carriers bill whole minutes, so that is what is counted. Recording
          // a 20-second call as a third of a minute would under-report the real
          // cost by two-thirds and make telephony look cheaper than it is.
          quantity: Math.ceil(captured.durationSec / 60),
          costMicros: voiceCostMicros(captured.durationSec),
          detail: { provider: "twilio", durationSec: captured.durationSec },
        });

        const call = await logCall(q, {
          callerName: captured.callerName,
          phone: captured.phone,
          durationSec: captured.durationSec,
          outcome: captured.outcome,
          summary: captured.summary,
          transcript: captured.transcript.map((t) => ({
            role: t.speaker === "Agent" ? ("agent" as const) : ("caller" as const),
            text: t.text,
          })),
          topic: captured.topic ?? null,
          requestedAt,
        });

        await processCall(q, call.id);
      });

      await endSession(callSid);

      return new Response(null, { status: 204 });
    }

    default:
      return new Response("Unknown action", { status: 404 });
  }
}
