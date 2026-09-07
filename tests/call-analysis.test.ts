import { describe, expect, it } from "vitest";
import { findEvidence, verifyAnalysis } from "../src/server/agent/call-analysis";
import type { TranscriptTurn } from "../src/server/repos/calls";

/**
 * Whether a model's reading of a call can be trusted onto a customer record.
 *
 * The point of this layer is not that a model summarises a call — anything can
 * do that. It is that every extracted claim has to quote the line it rests on,
 * and the quote is CHECKED. A finding whose evidence is not in the transcript
 * is dropped, because an invented supporting quote is worse than no claim at
 * all: the invented quote is what makes the claim convincing.
 *
 * So the important tests here are the dishonest payloads.
 */

const CALL: TranscriptTurn[] = [
  { role: "agent", text: "Thanks for calling. How can I help?" },
  { role: "caller", text: "We need a mobile crane on the Stellenbosch site for three days next month." },
  { role: "agent", text: "I can get that priced. Is there a budget you're working to?" },
  { role: "caller", text: "Around forty thousand, but honestly the timing matters more than the price." },
  { role: "agent", text: "Understood. I'll have someone send a quotation this week." },
];

const finding = (kind: string, detail: string, evidence: string) => ({ kind, detail, evidence });

describe("finding the line a claim rests on", () => {
  it("matches a quote that survived light tidying", () => {
    /* A model rarely reproduces speech exactly — it drops a comma, fixes a
       stutter. Rejecting that would throw away honest evidence. */
    expect(findEvidence(CALL, "we need a mobile crane on the stellenbosch site")).toBe(1);
    expect(findEvidence(CALL, "Around forty thousand — but the timing matters more")).toBe(-1);
    expect(findEvidence(CALL, "around forty thousand but honestly the timing matters more than the price")).toBe(3);
  });

  it("refuses a quote nobody said", () => {
    expect(findEvidence(CALL, "we have a budget of ninety thousand rand")).toBe(-1);
  });

  it("refuses a quote too short to mean anything", () => {
    /* "the crane" appears in any conversation about cranes. A coincidence is
       not evidence. */
    expect(findEvidence(CALL, "crane")).toBe(-1);
    expect(findEvidence(CALL, "a crane")).toBe(-1);
  });

  it("finds the turn, so the screen can show who said it", () => {
    expect(findEvidence(CALL, "I'll have someone send a quotation this week")).toBe(4);
  });
});

describe("verifying what a model claimed", () => {
  it("keeps findings the transcript supports", () => {
    const out = verifyAnalysis(CALL, {
      summary: "Caller wants a crane in Stellenbosch for three days.",
      findings: [
        finding("requirement", "Mobile crane, Stellenbosch, three days", "We need a mobile crane on the Stellenbosch site for three days next month."),
        finding("commitment", "Quotation to be sent this week", "I'll have someone send a quotation this week."),
      ],
    });
    expect(out.findings).toHaveLength(2);
    expect(out.grounding).toBe(100);
  });

  it("DROPS a finding whose evidence was invented", () => {
    /* The failure this whole module exists to catch. */
    const out = verifyAnalysis(CALL, {
      summary: "s",
      findings: [
        finding("budget", "Budget is ninety thousand", "The customer said their budget is ninety thousand rand."),
      ],
    });
    expect(out.findings).toHaveLength(0);
  });

  it("scores grounding against everything claimed, not everything kept", () => {
    /*
       Dividing kept by kept is always 100% — a metric that looks reassuring
       and measures nothing. Two claims, one real: 50%.
    */
    const out = verifyAnalysis(CALL, {
      summary: "s",
      findings: [
        finding("requirement", "Crane for three days", "We need a mobile crane on the Stellenbosch site for three days next month."),
        finding("budget", "Ninety thousand", "Our budget is ninety thousand rand for this."),
      ],
    });
    expect(out.findings).toHaveLength(1);
    expect(out.grounding).toBe(50);
  });

  it("stores the transcript's words as the evidence, not the model's paraphrase", () => {
    /* What is shown to a person has to be what was said. If the model's
       tidied version were stored, the screen would quote the machine while
       claiming to quote the customer. */
    const out = verifyAnalysis(CALL, {
      summary: "s",
      findings: [
        finding("requirement", "Crane", "we need a mobile crane on the stellenbosch site for three days next month"),
      ],
    });
    expect(out.findings[0].evidence).toBe(CALL[1].text);
    expect(out.findings[0].turn).toBe(1);
  });

  it("refuses a kind it does not recognise", () => {
    /* A model inventing a category would put a finding on screen that no
       filter, badge or report knows how to render. */
    const out = verifyAnalysis(CALL, {
      summary: "s",
      findings: [finding("blocker", "Something", "We need a mobile crane on the Stellenbosch site for three days next month.")],
    });
    expect(out.findings).toHaveLength(0);
  });

  it("survives a payload that is not the shape it promised", () => {
    /* Structured output is a strong hint, not a guarantee — and this runs
       unattended after a call, where a throw loses the rest of the pipeline. */
    for (const junk of [null, "a string", 42, {}, { findings: "not an array" }, { findings: [null, 7] }]) {
      const out = verifyAnalysis(CALL, junk);
      expect(out.findings).toEqual([]);
      expect(typeof out.summary).toBe("string");
    }
  });

  it("says 100% when the model claimed nothing", () => {
    /* Nothing asserted is nothing wrong. Scoring an empty extraction as zero
       would make a quiet call look like a hallucinating one. */
    expect(verifyAnalysis(CALL, { summary: "Short call.", findings: [] }).grounding).toBe(100);
  });

  it("keeps the summary even though it cannot be evidence-checked", () => {
    /* It is prose about the call as a whole, so there is no single line to
       point at. It is kept, and shown beside the grounding score. */
    const out = verifyAnalysis(CALL, { summary: "Caller wants a crane.", findings: [] });
    expect(out.summary).toBe("Caller wants a crane.");
  });

  it("truncates rather than storing whatever length the model felt like", () => {
    const out = verifyAnalysis(CALL, { summary: "x".repeat(5000), findings: [] });
    expect(out.summary.length).toBeLessThanOrEqual(800);
  });

  it("treats sentiment as advisory, and optional", () => {
    expect(verifyAnalysis(CALL, { summary: "s", findings: [] }).sentiment).toBeNull();
    expect(verifyAnalysis(CALL, { summary: "s", sentiment: "positive", findings: [] }).sentiment).toBe("positive");
  });
});
