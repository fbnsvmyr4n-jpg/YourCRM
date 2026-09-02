import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SOURCE_LABEL, SOURCE_VALUE } from "@/server/leads-view";
import { SOURCES } from "@/server/repos/deals";
import { LEAD_SOURCES } from "@/data/leads";

/**
 * Where a lead actually came from.
 *
 * A deal can carry seven sources. This page knew four, and the map that
 * translated them was typed `Record<string, LeadSource>` — which accepts any
 * subset, so nothing complained. The three it missed (website, outbound, other)
 * hit a `?? "Referral"` on the way out and were counted as referrals.
 *
 * On an eight-lead account that turned two real referrals into five: the panel
 * read "Referral 5 · 63%" and named Referral the top source, when the truth was
 * "Website 2 · 25%". That is not a cosmetic difference — it is the number a
 * business reads before deciding where to spend, and it pointed at the wrong
 * channel. It also broke the project's first rule, which is that nothing on
 * screen may be invented.
 *
 * There were three more copies of the same table, each independently partial:
 * the form's dropdown, the badge on a contact's avatar, and the icon on a lead
 * card. All four are now derived or exhaustively typed.
 */

/**
 * Source with comments stripped.
 *
 * These assertions are about what the code does, and the comments explaining
 * the bug necessarily quote the bug — the first version of the fallback test
 * failed on the sentence describing the fallback it had just removed.
 */
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("every source a deal can hold has a name on this page", () => {
  it("labels all of them", () => {
    for (const source of SOURCES) {
      expect(SOURCE_LABEL[source], `deal source "${source}" has no label`).toBeTruthy();
    }
    expect(Object.keys(SOURCE_LABEL).sort()).toEqual([...SOURCES].sort());
  });

  it("never labels one source as another", () => {
    /* The specific failure: website and outbound both arriving as "Referral".
       Two different sources sharing a label is indistinguishable, on the panel,
       from one source being twice as big. */
    const labels = Object.values(SOURCE_LABEL);
    expect(new Set(labels).size, "two deal sources share one label").toBe(labels.length);
  });

  it("offers every label in the form that creates a lead", () => {
    /* Otherwise a lead that genuinely came from the website cannot be recorded
       as one, and the panel has no way to ever be right. */
    expect([...LEAD_SOURCES].sort()).toEqual(Object.values(SOURCE_LABEL).sort());
  });

  it("round-trips a label back to the value it was stored as", () => {
    /* The form writes through SOURCE_VALUE and the page reads through
       SOURCE_LABEL. These used to be two hand-kept maps in different files,
       covering the same four of seven — so "Website" chosen in the form was
       stored as `other` and read back as something else again. */
    for (const source of SOURCES) {
      expect(SOURCE_VALUE[SOURCE_LABEL[source]], `"${source}" does not survive a round trip`).toBe(
        source
      );
    }
  });
});

describe("the fallbacks cannot invent a source", () => {
  it("does not fall back to a real channel", () => {
    /**
     * `?? "Referral"` was the whole bug: an unknown value was given the name of
     * a real acquisition channel and counted in its total. A fallback has to
     * land on "Other", which claims nothing.
     */
    const view = read("../src/server/leads-view.ts");
    expect(view).not.toMatch(/\?\?\s*"Referral"/);
    expect(view).toMatch(/\?\?\s*"Other"/);
  });

  it("types the table against the deal's own list", () => {
    /* `Record<string, …>` accepts a subset and is how this got through review.
       `satisfies Record<Source, …>` makes an eighth source a compile error. */
    const view = read("../src/server/leads-view.ts");
    expect(view).toMatch(/satisfies Record<Source, LeadSource>/);
    expect(view).not.toMatch(/const SOURCE_LABEL: Record<string,/);
  });

  it("draws a different picture for each source", () => {
    /**
     * Both icon components ended in a bare `return` that rendered the referral
     * mark for anything unmatched — so the cards agreed with the wrong numbers
     * rather than contradicting them. Declaring the glyph inside a
     * `Record<…, …>` makes a missing one fail to compile.
     */
    const icon = read("../src/components/ui/SourceIcon.tsx");
    expect(icon).toMatch(/const DISC: Record<\s*\n?\s*Exclude<LeadSource, "Google Ads" \| "Facebook">/);
    expect(icon).toMatch(/const disc = DISC\[source\];/);

    const badge = read("../src/components/ui/ChannelBadge.tsx");
    expect(badge).toMatch(/Glyph: \(\) => React\.ReactNode/);
    expect(badge).toMatch(/<s\.Glyph \/>/);
    /* The ternary chain that used to end in an envelope. */
    expect(badge).not.toMatch(/channel === "Google Ads" \? \(/);
  });

  it("builds the form's dropdown from the shared list", () => {
    const section = read("../src/app/(app)/leads/LeadCardsSection.tsx");
    expect(section).toMatch(/options=\{\[\.\.\.LEAD_SOURCES\]\}/);
    expect(section).not.toMatch(/options=\{\["Google Ads", "Facebook", "Referral", "Phone Call"\]\}/);
  });
});
