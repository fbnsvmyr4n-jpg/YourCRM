import { describe, expect, it } from "vitest";
import { describeFilter, isEmptyFilter, matchesFilter, parseFilter, type ContactFilter } from "../src/server/contact-filter";

/** Which contacts a filter keeps, and how it is said — no database. */

const f = (over: Partial<ContactFilter> = {}): ContactFilter => ({ type: "all", tagIds: [], match: "any", ...over });
const lead = (...tagIds: string[]) => ({ type: "lead" as const, tagIds });
const client = (...tagIds: string[]) => ({ type: "client" as const, tagIds });

describe("which contacts a filter keeps", () => {
  it("keeps everybody when nothing is chosen", () => {
    expect(matchesFilter(lead(), f())).toBe(true);
    expect(isEmptyFilter(f())).toBe(true);
  });

  it("filters by kind", () => {
    expect(matchesFilter(client(), f({ type: "lead" }))).toBe(false);
    expect(matchesFilter(lead(), f({ type: "lead" }))).toBe(true);
  });

  it("ANY: a contact with at least one of the tags", () => {
    const any = f({ tagIds: ["cpt", "dm"] });
    expect(matchesFilter(lead("dm"), any)).toBe(true);
    expect(matchesFilter(lead("other"), any)).toBe(false);
  });

  it("ALL: only a contact carrying every one", () => {
    const all = f({ tagIds: ["cpt", "dm"], match: "all" });
    expect(matchesFilter(lead("cpt"), all)).toBe(false);
    expect(matchesFilter(lead("dm", "cpt", "x"), all)).toBe(true);
  });

  it("combines kind and tags", () => {
    expect(matchesFilter(client("cpt"), f({ type: "lead", tagIds: ["cpt"] }))).toBe(false);
  });
});

describe("a filter from outside", () => {
  it("FALLS BACK TO EVERYTHING rather than refusing a malformed one", () => {
    expect(parseFilter(null)).toEqual(f());
    expect(parseFilter({ type: "vip", match: "most", tagIds: "cpt" })).toEqual(f());
  });

  it("drops repeats, blanks and tags that no longer exist", () => {
    expect(parseFilter({ type: "lead", tagIds: ["a", "a", "", 7, "gone", "b"], match: "all" }, new Set(["a", "b"]))).toEqual({
      type: "lead",
      tagIds: ["a", "b"],
      match: "all",
    });
  });
});

describe("saying a filter in English", () => {
  const names: Record<string, string> = { cpt: "Cape Town", dm: "Decision maker", cold: "Cold" };
  const say = (filter: ContactFilter) => describeFilter(filter, (id) => names[id]);

  it.each([
    [f(), "All contacts"],
    [f({ type: "client" }), "Clients only"],
    [f({ tagIds: ["cpt"] }), "Contacts tagged Cape Town"],
    [f({ type: "lead", tagIds: ["cpt", "dm", "cold"] }), "Leads tagged Cape Town, Decision maker or Cold"],
    [f({ type: "client", tagIds: ["cpt", "dm"], match: "all" }), "Clients tagged Cape Town and Decision maker"],
  ])("%j reads “%s”", (filter, text) => {
    expect(say(filter)).toBe(text);
  });
});
