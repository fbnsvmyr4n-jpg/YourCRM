/*
   Loading a supplier's list without being asked.

   Slice 2b of note 17. Slice 2 made an emailed list recognisable and still
   asked a person to look; this is the switch that lets a trusted merchant skip
   the looking — for the lists where there is nothing to look at.

   MOST OF THIS FILE IS ABOUT WHAT IT REFUSES TO DO UNATTENDED, and that is the
   point. `supplier-mail.ts` argues that a recognised list must never write
   itself, and the argument stands: an address can be spoofed, a supplier's own
   system can send a draft tariff, and every quotation this business sends is
   built from these numbers. The switch does not answer that argument by
   ignoring it. It answers it by doing the check the person was doing.

   A held list is not a refused list. It falls back to exactly what happens
   today: the card in the inbox, and somebody who looks.
*/
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MOVE_TOLERANCE,
  planChanges,
  unattendedVerdict,
  type ExistingItem,
  type ParsedLine,
} from "@/server/price-import";

const read = (p: string) => readFileSync(`${process.cwd()}/${p}`, "utf8");

const line = (name: string, unitCents: number, unit = "m²"): ParsedLine => ({
  name,
  unit,
  unitCents,
  source: `${name}\t${unit}\t${unitCents / 100}`,
});

/* What the workspace already holds — a baseline to judge a new list against. */
const ON_FILE: ExistingItem[] = [
  { id: "p-stone", name: "Paving stone", unitCents: 48000 },
  { id: "p-sand", name: "Bedding sand", unitCents: 32000 },
  { id: "p-labour", name: "Site labour", unitCents: 180000 },
];

const verdictFor = (lines: ParsedLine[], unread = 0, existing = ON_FILE) =>
  unattendedVerdict(planChanges(lines, existing), unread, existing.length);

describe("an ordinary list from a trusted supplier", () => {
  it("loads, when every price moved by an unremarkable amount", () => {
    /* Six, four and five per cent — a normal year. This is the case the whole
       feature exists for, and it is the only one that loads. */
    expect(
      verdictFor([line("Paving stone", 50900), line("Bedding sand", 33300), line("Site labour", 189000)])
    ).toEqual({ load: true });
  });

  it("loads when nothing changed at all", () => {
    /* "We checked their list on the 7th and it had not moved" is a useful fact,
       and `applyPriceList` stamps the date for it. Nothing is written to the
       prices, so there is nothing for a person to check. */
    expect(
      verdictFor([line("Paving stone", 48000), line("Bedding sand", 32000), line("Site labour", 180000)])
    ).toEqual({ load: true });
  });

  it("loads a list that only ADDS items", () => {
    /* A new product is not a changed price. There is nothing to compare it
       against and nothing it can silently re-price, so a human eye adds
       nothing that the preview on the price list screen will not give later. */
    expect(verdictFor([line("Paving stone", 48000), line("Kerb stone", 9900), line("Cement", 12500)])).toEqual(
      { load: true }
    );
  });
});

describe("what it hands back to a person", () => {
  it("A PRICE THAT MOVED TOO FAR, naming it and by how much", () => {
    /*
       The case that justifies the whole mechanism. A supplier's increase is
       usually under fifteen per cent; a third is unusual enough to be worth
       five seconds of somebody's attention.
    */
    const held = verdictFor([
      line("Paving stone", 48000),
      line("Bedding sand", 32000),
      line("Site labour", 300000),
    ]);
    expect(held).toEqual({ load: false, because: "Site labour went up by 67%" });
  });

  it("names the direction, because a collapse is as suspicious as a jump", () => {
    const held = verdictFor([
      line("Paving stone", 10000),
      line("Bedding sand", 32000),
      line("Site labour", 180000),
    ]);
    expect(held).toEqual({ load: false, because: "Paving stone came down by 79%" });
  });

  it("CATCHES THE MISPLACED DECIMAL, which is the error that actually happened", () => {
    /*
       R14,500 read as R500 — the parser bug found by driving this feature
       rather than by any test, when `columns()` split a thousands separator.
       A factor of ten is nowhere near the tolerance, so it is caught; and it
       would have passed every other check in the file, because the line parses
       perfectly and the sender is genuinely the supplier.
    */
    const held = verdictFor([
      line("Paving stone", 4800),
      line("Bedding sand", 32000),
      line("Site labour", 180000),
    ]);
    expect(held.load).toBe(false);
  });

  it("a line it could not read", () => {
    /*
       An unread line means the list is not shaped the way the parser expected
       — a new column order, a merged cell, a footnote. What it read AROUND
       that line is then a guess, and a guess is what a person is for.
    */
    const held = verdictFor(
      [line("Paving stone", 48000), line("Bedding sand", 32000), line("Site labour", 180000)],
      1
    );
    expect(held).toEqual({ load: false, because: "1 line could not be read" });
  });

  it("a price that arrived at nothing", () => {
    /* Free is not a price. A zero is a column read wrongly far more often than
       it is a merchant giving stone away, and applying it puts a nought into
       every quotation built from it afterwards. */
    const held = verdictFor([
      line("Paving stone", 0),
      line("Bedding sand", 32000),
      line("Site labour", 180000),
    ]);
    expect(held).toEqual({ load: false, because: "Paving stone came through with no price" });
  });

  it("THE FIRST LIST A SUPPLIER EVER SENDS", () => {
    /*
       With nothing on file there is nothing to compare against, so every check
       above is vacuous and would pass anything at all. That first load also
       sets the baseline every later judgement is made against — so loading it
       unseen would not be a safeguard that allowed it through, it would be no
       safeguard wearing the same face.
    */
    const held = verdictFor(
      [line("Paving stone", 48000), line("Bedding sand", 32000), line("Site labour", 180000)],
      0,
      []
    );
    expect(held).toEqual({
      load: false,
      because: "this is their first list, so there is nothing to compare it against",
    });
  });
});

describe("the tolerance", () => {
  it("is a third, and sits exactly where it says it does", () => {
    expect(MOVE_TOLERANCE).toBe(0.3);
    /* Just inside: 30% exactly is allowed, 31% is not. Asserted at the boundary
       because an off-by-one in a comparison here does not fail loudly — it
       silently changes how much the machine is trusted with. */
    const atLimit = verdictFor([line("Bedding sand", 41600)]); // +30%
    expect(atLimit).toEqual({ load: true });
    const over = verdictFor([line("Bedding sand", 42000)]); // +31.25%
    expect(over.load).toBe(false);
  });
});

describe("the wiring around it", () => {
  it("is OFF for every supplier unless somebody turned it on", () => {
    /* The honest default: it is the behaviour every existing workspace already
       has, and a migration that quietly starts writing prices nobody asked it
       to write would be this feature's own worst case. */
    expect(read("src/server/schema.sql")).toMatch(
      /ADD COLUMN IF NOT EXISTS auto_load BOOLEAN NOT NULL DEFAULT FALSE/
    );
  });

  it("CANNOT BE TURNED ON WITHOUT AN ADDRESS TO MATCH ON", () => {
    /*
       `findSupplierList` matches on the address and nothing else. So the switch
       on a supplier with no address can never once fire, and a control that
       silently does nothing is worse than one that is not offered: somebody
       turns it on, believes their prices are keeping themselves current, and
       quotes from a list that has not moved in a year.
    */
    const actions = read("src/app/(app)/pricing/actions.ts");
    expect(actions).toMatch(/if \(autoLoad && !email\)/);
  });

  it("writes prices through the MONEY door, not the mail one", () => {
    /*
       The load is triggered by a message arriving, which is mail work. What it
       writes is what this business pays for stone, which is not — and running
       it on the inbox's own querier would be the money gate quietly widened by
       proximity to the thing that happened to trigger it.
    */
    const inbox = read("src/app/(app)/inbox/actions.ts");
    expect(inbox).toMatch(/autoLoadFromMessage\(q, logged\.forPrices\),\s*\{ money: true \}/);
  });

  it("runs OUTSIDE the transaction that saved the message", () => {
    /*
       A price write refused — a view-only reader logging what a supplier said —
       would otherwise roll back the message they actually meant to save. The
       message is the thing they asked for; the price write is the part that is
       supposed to fail for them.
    */
    const inbox = read("src/app/(app)/inbox/actions.ts");
    const after = inbox.slice(inbox.indexOf('if ("error" in logged)'));
    expect(after.slice(0, 1800)).toMatch(/\.catch\(\(\) => null\)/);
  });

  it("asks whether this message was already loaded BEFORE applying anything", () => {
    /*
       Checked afterwards, a second call would re-apply the whole list and only
       then discover it had already been done — re-stamping the supplier's date
       and writing a second set of updates for a list nobody sent twice. The
       unique index is what makes it safe under a race; this is what makes it
       right under the ordinary one.
    */
    const auto = read("src/server/supplier-auto-load.ts");
    const check = auto.indexOf("loadForMessage(q, message.id)");
    const apply = auto.indexOf("applyPriceList(");
    expect(check, "the already-loaded check is gone").toBeGreaterThan(-1);
    expect(check).toBeLessThan(apply);
  });
});

describe("the record it leaves", () => {
  it("says WHO, and says nobody when it was nobody", () => {
    /* The null is the point of the column. "Nobody pressed anything" is a
       different fact from "we cannot remember who", and it is the first one
       somebody checks when a quotation comes out wrong. */
    const auto = read("src/server/supplier-auto-load.ts");
    expect(auto).toMatch(/userId: null,/);
    const card = read("src/components/pricing/PriceListInMail.tsx");
    expect(card).toMatch(/loaded automatically/);
  });

  it("is written for the manual path too", () => {
    /* A log covering only the unattended loads would answer "did the machine do
       this" and leave "who did" unanswerable — and the second is the question
       actually being asked. */
    const actions = read("src/app/(app)/pricing/actions.ts");
    expect(actions).toMatch(/await recordLoad\(q, \{[\s\S]{0,200}userId: q\.ctx\.userId/);
  });

  it("is ONE PER MESSAGE, in the database rather than by hoping", () => {
    /* A double-pressed button, a re-render, two tabs: all the same load. */
    expect(read("src/server/schema.sql")).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS price_list_loads_once_per_message/
    );
  });

  it("survives the message being binned", () => {
    /* Deleting the email must not erase the fact that its prices are in the
       quotations this business has already sent. */
    expect(read("src/server/schema.sql")).toMatch(
      /message_id\s+TEXT REFERENCES messages\(id\) ON DELETE SET NULL/
    );
  });

  it("stops the card offering to load a list it has already loaded", () => {
    /*
       Without this the card goes on saying "Review and load it" over prices
       that are already in, so the obedient thing to do is press it again. With
       automatic loading that is the COMMON case, not the odd one: the machine
       gets there before anybody opens the message.
    */
    const card = read("src/components/pricing/PriceListInMail.tsx");
    expect(card).toMatch(/if \(loaded\) \{/);
    /* The rendered control, not the comment explaining it — the first match for
       the bare label is this component's own docstring, which made the original
       assertion pass against prose rather than against the markup. */
    const offer = card.indexOf("<Link");
    expect(offer, "the offer to load is gone entirely").toBeGreaterThan(-1);
    expect(card.indexOf("if (loaded) {")).toBeLessThan(offer);
  });
});
