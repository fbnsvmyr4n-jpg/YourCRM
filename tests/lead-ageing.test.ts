import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatWait, leadAgeing, waitTone } from "@/server/leads-view";
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
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

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
  it("buckets against the two-hour target, on both sides of every boundary", () => {
    /**
     * The scale is hours because the business works in hours: a lead should be
     * answered within an hour or two, and a day is the worst acceptable case.
     * Week-and-month buckets reported a page full of green while a six-hour-old
     * lead was already late — the scale hid the exact failure this catches.
     *
     * Boundaries are asserted from both sides, because an off-by-one here
     * reports a breach as on-time.
     */
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: minsAgo(0) }),
        lead({ id: "b", createdAt: minsAgo(120) }), // exactly on target
        lead({ id: "c", createdAt: minsAgo(121) }), // one minute past it
        lead({ id: "d", createdAt: minsAgo(1440) }), // exactly a day
        lead({ id: "e", createdAt: minsAgo(1441) }), // past a day
      ],
      NOW
    );
    expect(r.buckets.map((b) => b.count)).toEqual([2, 2, 1]);
    expect(r.buckets.map((b) => b.id)).toEqual(["ontime", "late", "cold"]);
    expect(r.dated).toBe(5);
  });

  it("counts everything past the target as breaching", () => {
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: minsAgo(119) }),
        lead({ id: "b", createdAt: minsAgo(120) }),
        lead({ id: "c", createdAt: minsAgo(121) }),
        lead({ id: "d", createdAt: minsAgo(5000) }),
      ],
      NOW
    );
    expect(r.breaching).toBe(2);
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
    expect(r.oldest?.minutes).toBe(2 * 1440);
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
    const r = leadAgeing([lead({ id: "a", createdAt: minsAgo(-180) })], NOW);
    expect(r.buckets[0].count).toBe(1);
    expect(r.oldest?.minutes).toBe(0);
    expect(r.medianMinutes).toBe(0);
    expect(r.breaching).toBe(0);
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
    expect(r.medianMinutes).toBe(5 * 1440); // even count → mean of the middle two
    const mean = Math.round(((2 + 4 + 6 + 730) / 4) * 1440);
    expect(r.medianMinutes).not.toBe(mean);
  });

  it("returns null rather than zero when nothing is open", () => {
    /* Zero days waiting is a claim about performance. No open leads is an
       absence of data, and the card must be able to tell them apart. */
    const r = leadAgeing([lead({ id: "a", createdAt: daysAgo(9), status: "Closed Won" })], NOW);
    expect(r.medianMinutes).toBeNull();
    expect(r.oldest).toBeNull();
    expect(r.dated).toBe(0);
  });

  it("handles an empty account without throwing", () => {
    const r = leadAgeing([], NOW);
    expect(r.oldest).toBeNull();
    expect(r.medianMinutes).toBeNull();
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
    expect(r.oldest).toEqual({ name: "Forgotten Person", company: "Old Co", minutes: 64 * 1440 });
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
    expect(page).toMatch(/ageing\.medianMinutes === null \? "—"/);
    /* Anchored on the call, not a bare phrase. An earlier version of this
       assertion matched `/captured today/`, which passed against the COMMENT
       explaining the choice three lines above the code, and survived a
       mutation replacing the rendered string with the exact value it forbids. */
    expect(page).toMatch(/formatWait\(ageing\.oldest\.minutes\)/);
  });

  it("discloses leads it could not age", () => {
    expect(page).toMatch(/without a capture date, not counted above/);
  });
});

describe("formatting a wait", () => {
  it("uses the largest unit that still says something useful", () => {
    /* A lead answered in forty minutes reading as "0 days" is the reason this
       exists at all. */
    expect(formatWait(0)).toBe("just now");
    expect(formatWait(40)).toBe("40 min");
    expect(formatWait(59)).toBe("59 min");
    expect(formatWait(60)).toBe("1 hour");
    expect(formatWait(120)).toBe("2 hours");
    expect(formatWait(1439)).toBe("23 hours");
    expect(formatWait(1440)).toBe("1 day");
    expect(formatWait(2880)).toBe("2 days");
  });
});

describe("Lead Sources", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../src/app/(app)/leads/page.tsx", import.meta.url)),
    "utf8"
  );

  it("no longer repeats the filter strip's four counts", () => {
    /* Total / New / Open / Won sat here as well as at the top of the page,
       where the strip shows the same four numbers larger, first, and tappable.
       Repeating a figure does not reinforce it. */
    expect(page).not.toMatch(/MiniStat/);
    expect(page).not.toMatch(/label="Total"/);
  });
});

describe("the colour a wait is shown in", () => {
  it("turns amber past the target and red past a day", () => {
    /**
     * These two paths are the ones that matter and an account whose leads are
     * all fresh never renders them — inlined in the card they would have
     * shipped unverified. Boundaries from both sides, because an off-by-one
     * here paints a breach green.
     */
    expect(waitTone(0)).toBe("var(--green)");
    expect(waitTone(120)).toBe("var(--green)");
    expect(waitTone(121)).toBe("var(--amber)");
    expect(waitTone(1440)).toBe("var(--amber)");
    expect(waitTone(1441)).toBe("var(--red)");
    expect(waitTone(100000)).toBe("var(--red)");
  });

  it("has no verdict when nothing is open", () => {
    /* Not green. An empty pipeline is not a hit target. */
    expect(waitTone(null)).toBe("var(--text-muted)");
  });
});
