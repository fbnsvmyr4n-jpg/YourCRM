import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { leadAgeing } from "@/server/leads-view";
import type { LeadCard } from "@/data/leads";

/**
 * Lead ageing replaced Lead's Feed, which rendered the same array as the list
 * beside it — same names, same companies, same statuses, re-sorted and cut to
 * six. This answers a question the page could not answer at all: `createdAt`
 * is on every lead and appeared nowhere.
 *
 * Every figure is a count of records whose timestamp falls in a range, so the
 * whole surface is testable against fixed dates. `now` is injected for exactly
 * that reason.
 */

const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function lead(over: Partial<LeadCard> & { id: string }): LeadCard {
  return {
    initials: "XX",
    color: "blue",
    name: "Test Person",
    email: "",
    phone: "",
    location: "",
    company: "",
    status: "Follow-up Required",
    source: "Referral",
    ...over,
  } as LeadCard;
}

describe("lead ageing", () => {
  it("buckets open leads by how long they have waited", () => {
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: daysAgo(0) }),
        lead({ id: "b", createdAt: daysAgo(7) }),
        lead({ id: "c", createdAt: daysAgo(8) }),
        lead({ id: "d", createdAt: daysAgo(30) }),
        lead({ id: "e", createdAt: daysAgo(31) }),
      ],
      NOW
    );
    /* The boundaries are the whole point of a bucket, so they are asserted
       from both sides: 7 is "under a week", 8 is not; 30 is "1–4 weeks", 31
       is not. */
    expect(r.buckets.map((b) => b.count)).toEqual([2, 2, 1]);
    expect(r.dated).toBe(5);
  });

  it("excludes won leads — a closed deal's age is history, not work", () => {
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: daysAgo(100), status: "Closed Won" }),
        lead({ id: "b", createdAt: daysAgo(2), status: "New Lead" }),
      ],
      NOW
    );
    expect(r.dated).toBe(1);
    expect(r.oldest?.days).toBe(2);
  });

  it("reports undated leads instead of guessing or dropping them", () => {
    /**
     * `createdAt` is optional — rows predating the field have none. Inventing
     * an age would put a made-up number on screen; dropping them silently
     * would make these buckets disagree with the "Open" count on the panel
     * beside this one. So they are counted separately and disclosed.
     */
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: daysAgo(3) }),
        lead({ id: "b" }),
        lead({ id: "c", createdAt: "not a date" }),
      ],
      NOW
    );
    expect(r.dated).toBe(1);
    expect(r.undated).toBe(2);
    expect(r.buckets.reduce((s, b) => s + b.count, 0)).toBe(1);
  });

  it("clamps a future timestamp to zero rather than a negative age", () => {
    /* Bad data should not render as "-3 days waiting", and must not subtract
       from a bucket. */
    const r = leadAgeing([lead({ id: "a", createdAt: daysAgo(-3) })], NOW);
    expect(r.buckets[0].count).toBe(1);
    expect(r.oldest?.days).toBe(0);
    expect(r.medianDays).toBe(0);
  });

  it("uses a median, not a mean", () => {
    /* One lead sitting for two years drags an average past anything the user
       would recognise as typical. Mean here is 148; median is 4. */
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: daysAgo(2) }),
        lead({ id: "b", createdAt: daysAgo(4) }),
        lead({ id: "c", createdAt: daysAgo(6) }),
        lead({ id: "d", createdAt: daysAgo(730) }),
      ],
      NOW
    );
    expect(r.medianDays).toBe(5); // even count → mean of the middle two (4, 6)
    const mean = Math.round((2 + 4 + 6 + 730) / 4);
    expect(r.medianDays).not.toBe(mean);
  });

  it("returns null rather than zero when nothing is open", () => {
    /* Zero days waiting is a claim about performance. No open leads is an
       absence of data, and the card must be able to tell them apart. */
    const r = leadAgeing([lead({ id: "a", createdAt: daysAgo(9), status: "Closed Won" })], NOW);
    expect(r.medianDays).toBeNull();
    expect(r.oldest).toBeNull();
    expect(r.dated).toBe(0);
  });

  it("handles an empty account without throwing", () => {
    const r = leadAgeing([], NOW);
    expect(r.oldest).toBeNull();
    expect(r.medianDays).toBeNull();
    expect(r.undated).toBe(0);
    expect(r.buckets).toHaveLength(3);
  });

  it("names the single longest-waiting lead", () => {
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: daysAgo(5), name: "Recent Person" }),
        lead({ id: "b", createdAt: daysAgo(64), name: "Forgotten Person", company: "Old Co" }),
      ],
      NOW
    );
    expect(r.oldest).toEqual({ name: "Forgotten Person", company: "Old Co", days: 64 });
  });
});

describe("the page it replaced", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../src/app/(app)/leads/page.tsx", import.meta.url)),
    "utf8"
  );

  it("no longer renders Lead's Feed", () => {
    /* It was `[...leads].sort(...).slice(0, 6)` — the same array as the list
       beside it, showing the same name, company and status. */
    expect(page).not.toMatch(/LeadsFeedCard/);
    expect(page).not.toMatch(/Lead&apos;s Feed/);
    expect(page).toMatch(/<WaitingCard ageing=\{ageing\} \/>/);
  });

  it("derives the ageing from the rows already fetched", () => {
    /* No second query, and — more importantly — the ageing cannot disagree
       with the list it sits beside, because it is computed from it. */
    expect(page).toMatch(/ageing: leadAgeing\(rows\)/);
  });

  it("does not print a third copy of the open-lead count", () => {
    /**
     * An open count was the obvious partner for "typical wait", and it would
     * have been the THIRD copy of that number on this page: the filter strip
     * shows Follow-up, and Lead Sources shows Open in the card immediately
     * beside this one. Replacing a duplicated panel with a duplicated number
     * would have missed the point.
     */
    expect(page).not.toMatch(/Open now/);
    expect(page).toMatch(/median across \{total\} open lead/);
  });

  it("distinguishes no data from zero", () => {
    /* `medianDays === null` is "nothing open"; 0 is "all captured today".
       Rendering both as "0" would state a performance figure where there is
       none. */
    expect(page).toMatch(/ageing\.medianDays === null\s*\n?\s*\? "—"/);
    /* Anchored on the ternary, not the bare phrase. `/captured today/` alone
       passed against the COMMENT explaining the choice, three lines above the
       code — it survived a mutation that replaced the rendered string with
       "0 days", which is the exact thing it exists to forbid. */
    expect(page).toMatch(/\? "captured today"/);
  });

  it("discloses leads it could not age", () => {
    expect(page).toMatch(/without a capture date, not counted above/);
  });
});
