import { describe, expect, it } from "vitest";
import { decorateCall } from "../src/server/decorate-call";
import { CALL_OUTCOMES, OUTCOME_META, OUTCOME_UNRECORDED } from "../src/data/calls";
import type { CallRecord } from "../src/server/repos/calls";

/**
 * What a call is said to have come to.
 *
 * An outcome the allow-list did not recognise — including a call nobody had
 * classified yet — used to arrive on screen as "qualified". The call log then
 * labelled an unprocessed call a Qualified Lead: a sales judgement no person
 * and no agent had made, sitting in the same chip as the ones that were real.
 * Found on 18 Sep 2026 driving the call log against a fixture whose third call
 * was deliberately left unrecorded.
 */

const call = (outcome: string | null): CallRecord =>
  ({
    id: "call-1",
    contactId: null,
    callerName: "Unknown caller",
    phone: "+27825550199",
    receivedAt: "2026-09-16T09:00:00.000Z",
    durationSec: 95,
    outcome,
    summary: "Asked whether we do retaining walls.",
    topic: null,
    transcript: [],
    createdDealId: null,
    createdMeetingId: null,
    requestedAt: null,
    deletedAt: null,
  }) as unknown as CallRecord;

const outcomeOf = (stored: string | null) => decorateCall(call(stored), [], "UTC").outcome;

describe("a call's outcome", () => {
  it("IS NOT INVENTED when nobody recorded one", () => {
    expect(outcomeOf(null), "an unclassified call was given a sales outcome").toBe(null);
  });

  it("is not invented for a value we have no label for either", () => {
    expect(outcomeOf("lead_created")).toBe(null);
  });

  it("is carried through unchanged when it is one of ours", () => {
    for (const o of CALL_OUTCOMES) expect(outcomeOf(o)).toBe(o);
  });

  it("has something honest to show for every state the screen can be in", () => {
    /* The chip reads from one of these two; neither may be blank, or the log
       shows an empty pill where a person expects a word. */
    for (const o of CALL_OUTCOMES) expect(OUTCOME_META[o].label).not.toBe("");
    expect(OUTCOME_UNRECORDED.label).toBe("No outcome recorded");
  });
});
