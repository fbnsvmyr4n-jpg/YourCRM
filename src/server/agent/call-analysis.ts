import type { TranscriptTurn } from "../repos/calls";

/**
 * Reading a call, and proving it.
 *
 * A model summarising a phone call will occasionally state something the caller
 * never said. That is tolerable in a summary somebody skims and intolerable the
 * moment it becomes a field on a customer record — which is precisely what the
 * post-call pipeline does with it.
 *
 * So the specification's evidence requirement is implemented as a CHECK rather
 * than a convention. Every extracted finding must quote the line of transcript
 * it rests on, and this module then **verifies that quote actually appears in
 * the transcript**. A finding whose evidence cannot be found is dropped, not
 * flagged — a claim the model invented support for is worse than no claim,
 * because the invented support is what makes it convincing.
 *
 * `grounding` is what survived, as a percentage. A low number is a real signal
 * about a call — a bad line, a rambling caller, a model reaching — and it is
 * shown rather than hidden, so nobody trusts a summary that scored 40.
 *
 * Pure functions here: the parsing, the verification and the scoring take a
 * transcript and a payload and touch nothing else, so the part that decides
 * what is true is testable without a database or a model.
 */

/** The kinds of thing worth pulling out of a sales call. */
export const FINDING_KINDS = [
  "requirement",
  "commitment",
  "objection",
  "next_action",
  "budget",
  "timeline",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export type Finding = {
  kind: FindingKind;
  /** What was concluded, in the CRM's own words. */
  detail: string;
  /** The transcript line it rests on, verbatim. */
  evidence: string;
  /** Who said it — index into the transcript, so the screen can show context. */
  turn: number;
};

export type CallAnalysis = {
  intent: string | null;
  summary: string;
  findings: Finding[];
  /** 0-100: how much of what the model claimed was actually in the transcript. */
  grounding: number;
  /** Advisory only. Never drives a decision. */
  sentiment: string | null;
};

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

/**
 * Loose enough to survive punctuation, strict enough to catch invention.
 *
 * A model quoting a transcript rarely reproduces it character-for-character —
 * it drops a comma, fixes a stutter, changes "gonna" to "going to". Demanding
 * an exact match would reject honest evidence and teach us nothing.
 *
 * So both sides are reduced to their words. What this still catches is the
 * thing that matters: a quote containing words the caller never used.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/**
 * Which transcript turn a quotation came from, or -1.
 *
 * Containment either way round: the model may quote a fragment of a long turn,
 * or tidy a short one into something slightly longer. Both are honest; a quote
 * that appears in neither direction is not.
 */
export function findEvidence(transcript: TranscriptTurn[], quote: string): number {
  const needle = normalise(quote);
  /* Three words is the floor. Below that a quote matches half the call by
     accident — "the crane" appears in any conversation about cranes — and a
     coincidence is not evidence. */
  if (needle.split(" ").length < 3) return -1;

  return transcript.findIndex((turn) => {
    const hay = normalise(turn.text);
    return hay.includes(needle) || needle.includes(hay);
  });
}

/* ------------------------------------------------------------------ */
/* Parsing what the model returned                                     */
/* ------------------------------------------------------------------ */

const asRecord = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

const asText = (raw: unknown, max: number): string =>
  typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "";

/**
 * Turn a model's JSON into an analysis, keeping only what the transcript
 * supports.
 *
 * Separate from the API call so the rule that decides what is true can be
 * tested against handwritten payloads — including the dishonest ones, which is
 * the case worth having.
 */
export function verifyAnalysis(transcript: TranscriptTurn[], raw: unknown): CallAnalysis {
  const payload = asRecord(raw);

  const claimed = Array.isArray(payload.findings) ? payload.findings : [];
  const findings: Finding[] = [];
  for (const entry of claimed) {
    const item = asRecord(entry);
    const kind = FINDING_KINDS.find((k) => k === item.kind);
    const detail = asText(item.detail, 300);
    const evidence = asText(item.evidence, 400);
    if (!kind || !detail || !evidence) continue;

    const turn = findEvidence(transcript, evidence);
    /* The whole point. A finding the transcript does not support is dropped —
       and it still counts against `grounding` below, because the model having
       tried is the thing worth knowing. */
    if (turn === -1) continue;

    findings.push({ kind, detail, evidence: transcript[turn].text, turn });
  }

  /*
     Grounded on the claims, not on the survivors.

     Dividing kept by kept would always be 100%, which is the sort of metric
     that looks reassuring and measures nothing. This asks: of everything the
     model asserted, how much was really there?
  */
  const grounding = claimed.length === 0 ? 100 : Math.round((findings.length / claimed.length) * 100);

  /*
     The summary is NOT evidence-checked, deliberately.

     It is prose about the call as a whole rather than a claim about a specific
     sentence, so there is nothing to point at. It is stored as a model's
     account of the conversation and shown as one, next to a grounding score
     that says how well the same model did on the claims that COULD be checked.
  */
  return {
    intent: asText(payload.intent, 60) || null,
    summary: asText(payload.summary, 800),
    findings,
    grounding,
    sentiment: asText(payload.sentiment, 20) || null,
  };
}

/* ------------------------------------------------------------------ */
/* Asking for it                                                       */
/* ------------------------------------------------------------------ */

export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", description: "What the caller wanted, in three or four words." },
    summary: { type: "string", description: "Two or three sentences a colleague could read instead of the transcript." },
    sentiment: { type: "string", description: "One word: positive, neutral, frustrated, or unclear." },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...FINDING_KINDS] },
          detail: { type: "string", description: "What was concluded." },
          evidence: {
            type: "string",
            description:
              "The line from the transcript this rests on, quoted as closely as you can. It is checked against the transcript and dropped if it is not there.",
          },
        },
        required: ["kind", "detail", "evidence"],
      },
    },
  },
  required: ["summary", "findings"],
} as const;

export function analysisPrompt(transcript: TranscriptTurn[]): string {
  return [
    "Read this phone call and extract what a salesperson would need to know.",
    "",
    "Rules:",
    "Every finding must quote the line of the call it comes from. The quote is checked against the transcript and the finding is thrown away if it is not there — so quote, do not paraphrase from memory.",
    "Extract only what was actually said. If the caller did not state a budget, there is no budget finding.",
    "A commitment is something WE promised. A next action is something that still has to happen.",
    "The summary is for a colleague who will not read the transcript.",
    "",
    "=== TRANSCRIPT ===",
    ...transcript.map((t, i) => `[${i}] ${t.role}: ${t.text}`),
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Running it                                                          */
/* ------------------------------------------------------------------ */

/**
 * Analyse a finished call.
 *
 * Deliberately a different model choice from the live turn. Nobody is waiting:
 * the call has ended, this runs after the fact, and accuracy is worth more than
 * latency here — a wrong finding lands on a customer record and stays there.
 *
 * Returns null rather than throwing when there is nothing to say or nothing to
 * say it with. A call with no analysis is an ordinary state; a post-call
 * pipeline that throws is one that loses the rest of its work.
 */
export const ANALYSIS_MODEL = "claude-sonnet-5";

export async function analyseCall(
  transcript: TranscriptTurn[]
): Promise<CallAnalysis | null> {
  /* Two turns is a greeting and a goodbye. There is nothing in it to extract,
     and asking anyway spends money to be told so. */
  if (transcript.length < 3) return null;
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return null;

  const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
  const client = new AnthropicClient({ timeout: 30_000, maxRetries: 1 });

  const response = await client.messages.create({
    model: ANALYSIS_MODEL,
    max_tokens: 1500,
    thinking: { type: "adaptive" },
    output_config: {
      /* Higher than the live turn's `low`. This one is read by a person and
         acted on, and nobody is holding a telephone while it runs. */
      effort: "medium",
      format: { type: "json_schema", schema: ANALYSIS_SCHEMA },
    },
    messages: [{ role: "user", content: analysisPrompt(transcript) }],
  });

  const text = response.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* A structured output that is not JSON is a provider problem, not a call
       problem. The call keeps its transcript and its record; it simply has no
       analysis until somebody re-runs it. */
    return null;
  }

  return verifyAnalysis(transcript, parsed);
}
