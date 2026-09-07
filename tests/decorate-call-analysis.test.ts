import { describe, expect, it } from "vitest";
import { decorateCall } from "../src/server/decorate-call";
import type { CallRecord } from "../src/server/repos/calls";
import type { StoredAnalysis } from "../src/server/repos/call-analysis";

/**
 * What reaches the screen from a call's analysis.
 *
 * The verification itself is tested in `call-analysis.test.ts`; this is the
 * boundary after it, where a verified analysis becomes something a person
 * reads. Two things have to hold here, and neither is about correctness of the
 * model:
 *
 *   - a claim arrives with the line it rests on and the turn it came from, or
 *     the panel cannot let anybody check it;
 *   - an analysis with nothing in it does not arrive at all, because a heading
 *     over empty space reads as a broken feature rather than a quiet call.
 */

const CALL: CallRecord = {
  id: "call-1",
  contactId: null,
  callerName: "Marcus Reid",
  phone: "+27824471190",
  receivedAt: "2026-09-01T09:00:00.000Z",
  durationSec: 120,
  outcome: "qualified",
  summary: "Wants a crane.",
  topic: null,
  transcript: [
    { role: "agent", text: "Thanks for calling." },
    { role: "caller", text: "We need a mobile crane for three days." },
  ],
  createdDealId: null,
  createdMeetingId: null,
  requestedAt: null,
  deletedAt: null,
};

const analysis = (over: Partial<StoredAnalysis> = {}): StoredAnalysis => ({
  callId: "call-1",
  intent: "crane hire",
  summary: "Wants a crane.",
  findings: [
    {
      kind: "requirement",
      detail: "Mobile crane, three days",
      evidence: "We need a mobile crane for three days.",
      turn: 1,
    },
  ],
  grounding: 100,
  sentiment: "positive",
  model: "claude-sonnet-5",
  at: "2026-09-01T09:05:00.000Z",
  ...over,
});

describe("carrying an analysis onto the call panel", () => {
  it("keeps the quoted line and the turn it came from", () => {
    /* Without the turn the quote is unverifiable prose; without the quote the
       claim is just an assertion about a customer. */
    const out = decorateCall(CALL, [], "UTC", analysis());
    expect(out.analysis?.findings[0].evidence).toBe("We need a mobile crane for three days.");
    expect(out.analysis?.findings[0].turn).toBe(1);
  });

  it("carries the grounding score as it was scored", () => {
    /* Rounding, clamping or hiding a low score here would defeat the point of
       having one — a reader can only calibrate a summary they can see the
       score for. */
    expect(decorateCall(CALL, [], "UTC", analysis({ grounding: 40 })).analysis?.grounding).toBe(40);
  });

  it("sends nothing when there is nothing to show", () => {
    expect(decorateCall(CALL, [], "UTC", null).analysis).toBeUndefined();
    expect(decorateCall(CALL, [], "UTC").analysis).toBeUndefined();
    expect(
      decorateCall(CALL, [], "UTC", analysis({ findings: [], intent: null })).analysis
    ).toBeUndefined();
  });

  it("still sends an intent the model reached with no findings behind it", () => {
    /* A short call can have an obvious purpose and nothing quotable in it.
       That is worth a line on the panel. */
    const out = decorateCall(CALL, [], "UTC", analysis({ findings: [], intent: "crane hire" }));
    expect(out.analysis?.intent).toBe("crane hire");
    expect(out.analysis?.findings).toEqual([]);
  });

  it("does not disturb the rest of the card", () => {
    /* The analysis is additional. A call read badly must not change the
       caller, the outcome or the automation links. */
    const plain = decorateCall(CALL, [], "UTC");
    const read = decorateCall(CALL, [], "UTC", analysis({ grounding: 0, findings: [] }));
    expect({ ...read, analysis: undefined }).toEqual({ ...plain, analysis: undefined });
  });
});
