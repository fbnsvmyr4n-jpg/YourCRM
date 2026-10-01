import { describe, expect, it } from "vitest";
import { rateLabel, vatBreakdown } from "../src/server/vat";

/**
 * The tax arithmetic.
 *
 * This is the one calculation in the product whose result somebody else checks
 * — a bookkeeper, and eventually a revenue service. So it is held to a harder
 * standard than "looks right": the three figures must ADD UP, at every rate,
 * on every amount, in both directions.
 */

describe("a business that does not charge VAT", () => {
  it("SHOWS NOTHING AT ALL at a zero rate", () => {
    /* Not a zero row. "VAT 0.00" on a document from a business that is not
       registered invites the client to ask a question with no good answer. */
    expect(vatBreakdown(450000, 0, false)).toBeNull();
    expect(vatBreakdown(450000, 0, true)).toBeNull();
  });

  it("shows nothing for a rate that is not a number", () => {
    expect(vatBreakdown(450000, Number.NaN, false)).toBeNull();
    expect(vatBreakdown(450000, -1500, false)).toBeNull();
  });
});

describe("prices typed BEFORE tax (the default)", () => {
  it("ADDS the tax: R45,000 at 15% is R6,750, and the client pays R51,750", () => {
    const v = vatBreakdown(4500000, 1500, false);
    expect(v).toEqual({ netCents: 4500000, vatCents: 675000, grossCents: 5175000, rateBp: 1500 });
  });

  it("leaves the figure the lines add up to alone", () => {
    /* The net is the typed total, untouched. That figure is what the pipeline
       and the reports count, and filling in a tax number must not move it. */
    const v = vatBreakdown(1234567, 1500, false);
    expect(v?.netCents).toBe(1234567);
  });
});

describe("prices typed INCLUDING tax", () => {
  it("TAKES the tax out: R1,000 at 15% is R869.57 + R130.43", () => {
    const v = vatBreakdown(100000, 1500, true);
    expect(v).toEqual({ netCents: 86957, vatCents: 13043, grossCents: 100000, rateBp: 1500 });
  });

  it("never charges the client more than the figure they were quoted", () => {
    /* The gross IS the typed total. A client who was told R1,000 pays R1,000. */
    for (const total of [1, 99, 100, 12345, 999999]) {
      expect(vatBreakdown(total, 1500, true)?.grossCents).toBe(total);
    }
  });
});

describe("the column adds up", () => {
  it("NET + VAT === GROSS, at every rate, on every amount tried", () => {
    /* Two figures each rounded correctly on their own can still fail to sum,
       and a document whose own total does not add up is worse than none. */
    const amounts = [0, 1, 7, 33, 99, 100, 101, 4999, 100000, 123456789, -4500];
    const rates = [1, 100, 875, 1400, 1500, 2000, 2050, 10000];
    for (const total of amounts) {
      for (const rate of rates) {
        for (const inclusive of [true, false]) {
          const v = vatBreakdown(total, rate, inclusive);
          expect(v, `${total} at ${rate}bp`).not.toBeNull();
          expect(v!.netCents + v!.vatCents, `${total} at ${rate}bp inclusive=${inclusive}`).toBe(
            v!.grossCents
          );
          expect(Number.isSafeInteger(v!.netCents)).toBe(true);
          expect(Number.isSafeInteger(v!.vatCents)).toBe(true);
        }
      }
    }
  });

  it("rounds a credit note the same way as the invoice it reverses", () => {
    /* Half away from zero, both directions — otherwise a reversal leaves an
       unexplainable cent behind in somebody's books. */
    const up = vatBreakdown(350, 1500, false);
    const down = vatBreakdown(-350, 1500, false);
    expect(up?.vatCents).toBe(53); /* 52.5 → 53 */
    expect(down?.vatCents).toBe(-53);
    expect(up!.vatCents + down!.vatCents).toBe(0);
  });

  it("holds exactly at a rate of 100%", () => {
    expect(vatBreakdown(100000, 10000, false)).toEqual({
      netCents: 100000,
      vatCents: 100000,
      grossCents: 200000,
      rateBp: 10000,
    });
    expect(vatBreakdown(100000, 10000, true)).toEqual({
      netCents: 50000,
      vatCents: 50000,
      grossCents: 100000,
      rateBp: 10000,
    });
  });
});

describe("the label on the row", () => {
  it("reads as a person would write the rate", () => {
    expect(rateLabel(1500)).toBe("15%");
    expect(rateLabel(2000)).toBe("20%");
    expect(rateLabel(875)).toBe("8.75%");
    expect(rateLabel(1250)).toBe("12.5%");
    expect(rateLabel(1505)).toBe("15.05%");
    expect(rateLabel(0)).toBe("0%");
  });

  it("does not ask the browser what a percent looks like", async () => {
    /* Rendered on the server and again in the client; `Intl` need not give the
       two the same answer, which React reports as a hydration mismatch. */
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("../src/server/vat.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/Intl\.|toLocaleString/);
  });
});
