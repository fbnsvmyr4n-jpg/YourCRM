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

const NOW = Date.parse("2026-08-26T12:00:00.000Z"); // a Wednesday, midday UTC
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

describe("the ageing ladder", () => {
  it("puts every open lead on exactly one rung", () => {
    /**
     * The rungs must partition the open leads. If they ever overlapped or left
     * a gap, the bars would silently stop summing to the count the rest of the
     * page shows — the failure would look like a design choice rather than a
     * bug, which is the worst kind.
     */
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: minsAgo(5) }),
        lead({ id: "b", createdAt: minsAgo(59) }),
        lead({ id: "c", createdAt: minsAgo(60) }),
        lead({ id: "d", createdAt: minsAgo(300) }),
        lead({ id: "e", createdAt: "2026-08-25T09:00:00.000Z" }),
        lead({ id: "f", createdAt: "2026-08-24T09:00:00.000Z" }),
        lead({ id: "g", createdAt: "2026-06-01T09:00:00.000Z" }),
      ],
      "UTC",
      NOW
    );
    expect(r.buckets.map((b) => b.id)).toEqual(["hour", "today", "yesterday", "waiting"]);
    expect(r.buckets.map((b) => b.count)).toEqual([2, 2, 1, 2]);
    expect(r.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(r.dated);
  });

  it("lets recency beat the calendar at the hour boundary", () => {
    /**
     * This is the case that makes the order of the rungs load-bearing rather
     * than cosmetic.
     *
     * A lead captured at 23:40 is an hour old at 00:40 the next morning. By
     * the calendar it belongs to yesterday; by the clock the person has done
     * nothing wrong. The hour rung is tested FIRST, so it reads "within the
     * hour" and the panel does not accuse somebody who is on target.
     *
     * One minute later the same lead is 60 minutes old and drops to
     * "yesterday", which is then the truth.
     */
    const captured = "2026-08-25T23:40:00.000Z";
    /* 59 minutes past capture, and 39 minutes into the next calendar day.
       "Within the hour" is strictly under 60: at exactly 60 the hour has been
       missed, which is the whole point of the target. */
    const justBefore = Date.parse("2026-08-26T00:39:00.000Z");

    const onTarget = leadAgeing([lead({ id: "a", createdAt: captured })], "UTC", justBefore);
    expect(onTarget.buckets.find((b) => b.id === "hour")?.count).toBe(1);
    expect(onTarget.buckets.find((b) => b.id === "yesterday")?.count).toBe(0);

    const past = leadAgeing([lead({ id: "a", createdAt: captured })], "UTC", justBefore + 60_000);
    expect(past.buckets.find((b) => b.id === "hour")?.count).toBe(0);
    expect(past.buckets.find((b) => b.id === "yesterday")?.count).toBe(1);
  });

  it("breaks the days where the business's day breaks, not where UTC does", () => {
    /**
     * 22:00 UTC on the 25th is already 00:00 on the 26th in Johannesburg. To
     * someone opening this page in that office it is today's lead; UTC would
     * file it under yesterday and hand them a pile that is not theirs.
     */
    const at = Date.parse("2026-08-26T06:00:00.000Z");
    const captured = "2026-08-25T22:00:00.000Z";

    const jhb = leadAgeing([lead({ id: "a", createdAt: captured })], "Africa/Johannesburg", at);
    expect(jhb.buckets.find((b) => b.id === "today")?.count).toBe(1);

    const utc = leadAgeing([lead({ id: "a", createdAt: captured })], "UTC", at);
    expect(utc.buckets.find((b) => b.id === "yesterday")?.count).toBe(1);
  });

  it("rolls yesterday's uncalled leads into Still waiting the next day", () => {
    /* The behaviour the ladder exists for: leave it and it escalates on its
       own, without anybody editing a record. */
    const captured = "2026-08-25T09:00:00.000Z";
    const today = leadAgeing([lead({ id: "a", createdAt: captured })], "UTC", NOW);
    expect(today.buckets.find((b) => b.id === "yesterday")?.count).toBe(1);

    const tomorrow = leadAgeing([lead({ id: "a", createdAt: captured })], "UTC", NOW + 86_400_000);
    expect(tomorrow.buckets.find((b) => b.id === "yesterday")?.count).toBe(0);
    expect(tomorrow.buckets.find((b) => b.id === "waiting")?.count).toBe(1);
  });

  it("counts everything that missed the hour as breaching", () => {
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: minsAgo(59) }),
        lead({ id: "b", createdAt: minsAgo(60) }),
        lead({ id: "c", createdAt: minsAgo(5000) }),
      ],
      "UTC",
      NOW
    );
    expect(r.breaching).toBe(2);
  });

  it("excludes won leads — a closed deal's age is history, not work", () => {
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: daysAgo(100), status: "Closed Won" }),
        lead({ id: "b", createdAt: minsAgo(10), status: "New Lead" }),
      ],
      "UTC",
      NOW
    );
    expect(r.dated).toBe(1);
    expect(r.oldest?.minutes).toBe(10);
  });

  it("reports undated leads instead of guessing or dropping them", () => {
    /**
     * `createdAt` is optional — rows predating the field have none. Inventing
     * an age would put a made-up number on screen; dropping them silently
     * would make these rungs disagree with the lead counts elsewhere on the
     * page. So they are counted separately and disclosed.
     */
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: minsAgo(30) }),
        lead({ id: "b" }),
        lead({ id: "c", createdAt: "not a date" }),
      ],
      "UTC",
      NOW
    );
    expect(r.dated).toBe(1);
    expect(r.undated).toBe(2);
    expect(r.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1);
  });

  it("clamps a future timestamp instead of ranking it by being ahead of the clock", () => {
    /* Bad data must not render as "-3 hours waiting", and must land on the
       first rung rather than wherever its calendar date happens to fall. */
    const r = leadAgeing([lead({ id: "a", createdAt: minsAgo(-180) })], "UTC", NOW);
    expect(r.buckets.find((b) => b.id === "hour")?.count).toBe(1);
    expect(r.oldest?.minutes).toBe(0);
    expect(r.medianMinutes).toBe(0);
    expect(r.breaching).toBe(0);
  });

  it("uses a median, not a mean", () => {
    /* One lead forgotten for two years drags an average past anything the
       user would recognise as typical. */
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: minsAgo(10) }),
        lead({ id: "b", createdAt: minsAgo(20) }),
        lead({ id: "c", createdAt: minsAgo(30) }),
        lead({ id: "d", createdAt: daysAgo(730) }),
      ],
      "UTC",
      NOW
    );
    expect(r.medianMinutes).toBe(25);
    const mean = Math.round((10 + 20 + 30 + 730 * 1440) / 4);
    expect(r.medianMinutes).not.toBe(mean);
  });

  it("returns null rather than zero when nothing is open", () => {
    /* Zero minutes waiting is a claim about performance. No open leads is an
       absence of data, and the card must be able to tell them apart. */
    const r = leadAgeing([lead({ id: "a", createdAt: daysAgo(9), status: "Closed Won" })], "UTC", NOW);
    expect(r.medianMinutes).toBeNull();
    expect(r.oldest).toBeNull();
    expect(r.dated).toBe(0);
  });

  it("handles an empty account without throwing", () => {
    const r = leadAgeing([], "UTC", NOW);
    expect(r.oldest).toBeNull();
    expect(r.medianMinutes).toBeNull();
    expect(r.undated).toBe(0);
    expect(r.buckets).toHaveLength(4);
  });

  it("names the single longest-waiting lead", () => {
    const r = leadAgeing(
      [
        lead({ id: "a", createdAt: minsAgo(5), name: "Recent Person" }),
        lead({ id: "b", createdAt: daysAgo(64), name: "Forgotten Person", company: "Old Co" }),
      ],
      "UTC",
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
       with the list it sits beside, because it is computed from it. The zone
       comes from settings, so "yesterday" means yesterday where the business
       is rather than wherever the server happens to run. */
    expect(page).toMatch(/ageing: leadAgeing\(rows, timeZone \|\| "UTC"\)/);
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
  it("escalates through four steps, each boundary checked from both sides", () => {
    /**
     * These two paths are the ones that matter and an account whose leads are
     * all fresh never renders them — inlined in the card they would have
     * shipped unverified. Boundaries from both sides, because an off-by-one
     * here paints a breach green.
     */
    expect(waitTone(0)).toBe("var(--green)");
    expect(waitTone(59)).toBe("var(--green)");
    expect(waitTone(60)).toBe("var(--amber)"); // the hour is missed AT 60
    expect(waitTone(1439)).toBe("var(--amber)");
    expect(waitTone(1440)).toBe("var(--red)"); // a full day
    expect(waitTone(2879)).toBe("var(--red)");
    expect(waitTone(2880)).toBe("var(--red-deep)"); // two days: neglected
    expect(waitTone(100000)).toBe("var(--red-deep)");
  });

  it("has no verdict when nothing is open", () => {
    /* Not green. An empty pipeline is not a hit target. */
    expect(waitTone(null)).toBe("var(--text-muted)");
  });
});
