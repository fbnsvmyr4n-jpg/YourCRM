import { describe, expect, it } from "vitest";
import {
  checkDefinition,
  displayValue,
  parseOptions,
  parseValue,
  type CustomField,
} from "../src/server/custom-field-rules";

/** A field somebody defines, and a value somebody types into it — no database. */

const field = (kind: CustomField["kind"], options: string[] = []) => ({ label: "Capacity", kind, options });

describe("defining a field", () => {
  it("accepts a named field of a known kind", () => {
    expect(checkDefinition({ label: "  Lifting   capacity ", kind: "number", options: "" })).toEqual({
      label: "Lifting capacity",
      kind: "number",
      options: [],
    });
  });

  it.each([
    ["no name", { label: "   ", kind: "text" }, /name/],
    ["an unknown kind", { label: "X", kind: "file" }, /kind/],
    ["a choice list with no choices", { label: "X", kind: "choice", options: "\n \n" }, /at least one choice/],
  ])("refuses %s", (_what, raw, pattern) => {
    const out = checkDefinition({ options: "", ...raw });
    expect("error" in out && out.error).toMatch(pattern);
  });

  it("DROPS CHOICES OFF A FIELD THAT IS NOT A CHOICE LIST, rather than storing a dropdown nobody sees", () => {
    const out = checkDefinition({ label: "Notes", kind: "text", options: "a\nb" });
    expect("options" in out && out.options).toEqual([]);
  });

  it("reads choices one per line, dropping blanks and repeats that differ only in case", () => {
    expect(parseOptions("Tower crane\n\n  Mobile crane \ntower CRANE\nCrawler")).toEqual([
      "Tower crane",
      "Mobile crane",
      "Crawler",
    ]);
  });

  it("caps the number of choices", () => {
    const many = Array.from({ length: 31 }, (_, i) => `Option ${i}`).join("\n");
    const out = checkDefinition({ label: "X", kind: "choice", options: many });
    expect("error" in out && out.error).toMatch(/up to 30/);
  });
});

describe("typing a value", () => {
  it("TREATS AN EMPTY INPUT AS NOT SET, for every kind", () => {
    for (const kind of ["text", "number", "date", "choice", "yes_no"] as const) {
      expect(parseValue(field(kind, ["A"]), "   ")).toEqual({ value: null });
    }
  });

  it.each([
    ["12500", "12500"],
    ["12 500", "12500"],
    ["12,500", "12500"],
    ["0012.50", "12.5"],
    ["-3.1400", "-3.14"],
    ["-0", "0"],
    ["7.", null],
  ])("reads the number %s as %s", (typed, stored) => {
    const out = parseValue(field("number"), typed);
    if (stored === null) expect("error" in out).toBe(true);
    else expect(out).toEqual({ value: stored });
  });

  it("refuses what is not a number, naming the field", () => {
    expect(parseValue(field("number"), "about fifty")).toEqual({ error: "Capacity must be a number." });
    expect("error" in parseValue(field("number"), "1.23456")).toBe(true);
  });

  it("A DATE MUST BE A REAL DAY, not merely date-shaped", () => {
    expect(parseValue(field("date"), "2026-02-28")).toEqual({ value: "2026-02-28" });
    expect("error" in parseValue(field("date"), "2026-02-30")).toBe(true);
    expect("error" in parseValue(field("date"), "28/02/2026")).toBe(true);
  });

  it("matches a choice ignoring case, and stores the field's own spelling", () => {
    expect(parseValue(field("choice", ["Tower crane"]), "TOWER CRANE")).toEqual({ value: "Tower crane" });
    expect(parseValue(field("choice", ["Tower crane"]), "Forklift")).toEqual({
      error: "Forklift is not one of the choices for Capacity.",
    });
  });

  it("stores yes and no in one spelling", () => {
    expect(parseValue(field("yes_no"), "Yes")).toEqual({ value: "yes" });
    expect("error" in parseValue(field("yes_no"), "maybe")).toBe(true);
  });

  it("keeps text as typed, trimmed and bounded", () => {
    const out = parseValue(field("text"), `  Gate ${"x".repeat(900)}`);
    expect("value" in out && out.value!.length).toBe(500);
  });
});

describe("showing a value", () => {
  it("formats each kind the same way on the server and in the browser", () => {
    expect(displayValue("date", "2026-09-06")).toBe("6 Sep 2026");
    expect(displayValue("number", "1250000.5")).toBe("1,250,000.5");
    expect(displayValue("number", "-42")).toBe("−42");
    expect(displayValue("yes_no", "no")).toBe("No");
    expect(displayValue("choice", "Tower crane")).toBe("Tower crane");
  });

  it("shows nothing for a value that is not set", () => {
    expect(displayValue("text", undefined)).toBe("");
  });
});
