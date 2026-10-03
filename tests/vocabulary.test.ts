import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STAGES } from "../src/server/repos/deals";
import {
  DEFAULT_VOCABULARY,
  VOCABULARIES,
  isVocabulary,
  stagesFor,
  wordsFor,
} from "../src/data/vocabulary";
import { boardStages, stageMeta } from "../src/data/pipeline";

/**
 * What a workspace calls its own work.
 *
 * The pipeline was written in one industry's language — Prospect, Discovery,
 * Demo, "exits when the value case is made against those pains" — which is
 * right for a sales team and meaningless to a contractor, who does not demo
 * anything. The seven states are the same either way.
 *
 * The property that makes this safe, and the one every test here is really
 * about: IT IS WORDS ONLY. Nothing about the data moves, so a workspace can
 * switch, switch back, and lose nothing.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("the two sets", () => {
  it("COVER EVERY STAGE THE DATABASE ALLOWS", () => {
    /* A missing stage would render a column with no name — and because the
       stage ids come from the repo, a stage added later fails here rather than
       silently appearing blank on somebody's board. */
    for (const vocabulary of VOCABULARIES) {
      const words = wordsFor(vocabulary);
      for (const id of STAGES) {
        expect(words.stages[id]?.label, `${vocabulary} has no label for ${id}`).toBeTruthy();
        expect(words.stages[id]?.exit, `${vocabulary} has no exit condition for ${id}`).toBeTruthy();
      }
    }
  });

  it("CHANGE NOTHING BUT THE WORDS — same ids, same order", () => {
    const sales = stagesFor("sales").map((s) => s.id);
    const trades = stagesFor("trades").map((s) => s.id);
    expect(trades).toEqual(sales);
    expect(trades).toEqual([...STAGES]);
  });

  it("speak like the trade they are for", () => {
    /* Not a translation of the sales word: a contractor goes and looks before
       pricing, and what moves a job on is the customer accepting the price. */
    const trades = wordsFor("trades").stages;
    expect(trades.prospect.label).toBe("Enquiry");
    expect(trades.discovery.label).toBe("Site visit");
    expect(trades.demo.label).toBe("Quoted");
    expect(trades.delivery.label).toBe("On site");
    expect(trades.demo.exit).toMatch(/accepts the price/);
    /* And nothing in the trades set still talks about demos or pain points. */
    for (const stage of Object.values(trades)) {
      expect(`${stage.label} ${stage.exit}`).not.toMatch(/demo|pain point/i);
    }
  });

  it("FALLS BACK rather than rendering nothing", () => {
    /* The value arrives from a database column and is whatever is in it. A
       workspace saved by a newer build must read in the old build's language,
       not as a screen full of `undefined`. */
    expect(wordsFor("something-new").one).toBe(wordsFor(DEFAULT_VOCABULARY).one);
    expect(wordsFor(null).stages.prospect.label).toBe("Prospect");
    expect(isVocabulary("trades")).toBe(true);
    expect(isVocabulary("real-estate")).toBe(false);
  });

  it("defaults to the words every existing workspace already reads", () => {
    /* Defaulting to trades would rename the board under people who never asked
       for it. */
    expect(DEFAULT_VOCABULARY).toBe("sales");
    expect(wordsFor(undefined).stages.demo.label).toBe("Demo");
  });
});

describe("the board", () => {
  it("TAKES THE WORKSPACE'S WORDS, keeping each stage's own colour", () => {
    const sales = stageMeta("discovery", "sales");
    const trades = stageMeta("discovery", "trades");
    expect(sales.label).toBe("Discovery");
    expect(trades.label).toBe("Site visit");
    /* The colour and the id belong to the STAGE; only the words belong to the
       business. A trades board must not come out a different colour. */
    expect(trades.color).toBe(sales.color);
    expect(trades.id).toBe(sales.id);
  });

  it("still leaves Lost off the columns", () => {
    for (const vocabulary of VOCABULARIES) {
      expect(boardStages(vocabulary).map((s) => s.id)).not.toContain("lost");
      expect(boardStages(vocabulary)).toHaveLength(STAGES.length - 1);
    }
  });
});

describe("how it reaches the screens", () => {
  it("is stored per workspace and checked against the known sets", () => {
    const schema = read("../src/server/schema.sql");
    expect(schema).toMatch(/ALTER TABLE settings ADD COLUMN IF NOT EXISTS vocabulary TEXT NOT NULL DEFAULT 'sales'/);
    expect(schema).toMatch(/CHECK \(vocabulary IN \('sales', 'trades'\)\)/);
  });

  it("IS READ ONCE BY THE LAYOUT, not threaded through every screen", () => {
    /* The same shape as the currency, and for the same reason: a hard-coded
       word spreads to two dozen files otherwise. */
    const shell = read("../src/components/shell/AppShell.tsx");
    expect(shell).toMatch(/<VocabularyProvider vocabulary=\{vocabulary\}>/);
    const board = read("../src/app/(app)/deals/DealsBoard.tsx");
    expect(board).toMatch(/const vocabulary = useVocabulary\(\);/);
    expect(board).toMatch(/const STAGES = boardStages\(vocabulary\)/);
  });

  it("names no stage in the board's own markup", () => {
    /* A tile that says "Discovery and Demo" over a trades board is naming
       columns that are not on the screen. */
    const board = read("../src/app/(app)/deals/DealsBoard.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(board).not.toMatch(/sub="Discovery and Demo"/);
    expect(board).not.toMatch(/>Deals Pipeline</);
  });
});
