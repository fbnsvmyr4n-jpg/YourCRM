/**
 * Intent matching for the assistant's offline mode.
 *
 * The previous version was a chain of `if (q.includes("pipeline"))` checks: the
 * first keyword to appear anywhere won, one typo missed the intent entirely,
 * and only eight questions were reachable. This replaces that with scoring —
 * every intent is evaluated, the best one answers, and a near-miss still finds
 * its target because matching is done on fuzzy tokens rather than substrings.
 *
 * Pure and dependency-free so it can be unit-tested without a browser or a
 * database.
 */

/** Words that carry no intent and would otherwise pad every score. */
const STOP = new Set([
  "a", "an", "the", "is", "are", "was", "were", "do", "does", "did", "i", "me",
  "my", "we", "our", "you", "your", "of", "for", "to", "in", "on", "at", "and",
  "or", "with", "what", "whats", "how", "many", "much", "any", "can", "please",
  "show", "tell", "give", "get", "list", "there", "it", "that", "this", "have",
  "has", "hows", "s", "am",
]);

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/['']/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOP.has(t));
}

/**
 * Levenshtein distance, capped early.
 *
 * The cap matters: without it a long word is compared in full against every
 * keyword of every intent on each keystroke, and this runs on every message.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < best) best = curr[j];
    }
    if (best > max) return max + 1; // no path back under the cap
    prev = curr;
  }
  return prev[b.length];
}

/**
 * How well a typed token matches a keyword.
 * Exact beats prefix beats near-miss, so "pipeline" outranks "pipe" outranks
 * "pipelien". Longer words tolerate a second typo; short ones do not, because
 * at three letters an edit distance of two matches almost anything.
 */
export function tokenScore(token: string, keyword: string): number {
  if (token === keyword) return 1;
  if (keyword.startsWith(token) && token.length >= 4) return 0.8;
  if (token.startsWith(keyword) && keyword.length >= 4) return 0.8;

  const allowed = keyword.length >= 7 ? 2 : keyword.length >= 5 ? 1 : 0;
  if (allowed === 0) return 0;

  const d = editDistance(token, keyword, allowed);
  if (d > allowed) return 0;
  return d === 1 ? 0.65 : 0.45;
}

export type Intent = {
  id: string;
  /** Any of these matching contributes to the score. */
  keywords: string[];
  /** Matching two of these together is strong evidence — "how many leads". */
  phrases?: string[];
  /** Nudges intents apart when they legitimately share vocabulary. */
  weight?: number;
};

export type Match = { id: string; score: number };

/**
 * Score every intent and return them best-first.
 *
 * Returning the ranked list rather than a single winner lets the caller show
 * "did you mean" alternatives when the top score is weak, instead of
 * confidently answering the wrong question.
 */
export function rankIntents(
  input: string,
  intents: Intent[],
  /**
   * `unique` counts each distinct word once.
   *
   * Off for chat, where questions are short enough that repetition is
   * meaningless either way. On for classifying a whole email, where a topical
   * word from the subject recurring through the body would otherwise outscore
   * several strong phrase matches — "Re: Sales automation demo … thanks for
   * making time for the demo" scored as a meeting request purely on how often
   * the word "demo" appeared.
   */
  options: { unique?: boolean } = {}
): Match[] {
  const raw = tokenize(input);
  const tokens = options.unique ? [...new Set(raw)] : raw;
  const lower = input.toLowerCase().trim();

  // Not `tokens.length === 0` — a perfectly good question can be built
  // entirely from stop words ("what can you do"), leaving nothing to tokenize
  // while still matching a phrase exactly. Only genuinely empty input bails.
  if (!lower) return [];

  return intents
    .map((intent) => {
      let score = 0;

      for (const token of tokens) {
        let best = 0;
        for (const kw of intent.keywords) {
          const s = tokenScore(token, kw);
          if (s > best) best = s;
        }
        score += best;
      }

      // Whole phrases are much stronger evidence than isolated words.
      for (const phrase of intent.phrases ?? []) {
        if (lower.includes(phrase)) score += 1.5;
      }

      // Normalise by length so a rambling question doesn't outscore a terse
      // one purely by having more words in it. Floored at 1 so an all-stop-word
      // question that matched a phrase isn't divided by zero.
      score = score / Math.sqrt(Math.max(tokens.length, 1));
      return { id: intent.id, score: score * (intent.weight ?? 1) };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Below this the match is too weak to answer confidently. */
export const CONFIDENT = 0.55;

/**
 * Find a person, company or deal the user named.
 *
 * Matches whole tokens rather than substrings — a bare `includes` makes "al"
 * match "Alison", "Alex" and "Personal", so a short word in an unrelated
 * question would drag in a random record.
 */
export function findEntity<T>(
  input: string,
  items: T[],
  label: (item: T) => string
): T | null {
  const tokens = tokenize(input);
  if (!tokens.length) return null;

  let best: { item: T; score: number } | null = null;

  for (const item of items) {
    const words = tokenize(label(item));
    if (!words.length) continue;

    let hits = 0;
    for (const word of words) {
      if (word.length < 3) continue;
      for (const token of tokens) {
        if (tokenScore(token, word) >= 0.8) {
          hits += 1;
          break;
        }
      }
    }
    if (hits === 0) continue;

    // Favour matching more of the name: "Alex Carter" beats "Alex".
    const score = hits / words.length + hits * 0.1;
    if (!best || score > best.score) best = { item, score };
  }

  // One matched word out of several is usually coincidence.
  return best && best.score >= 0.55 ? best.item : null;
}
