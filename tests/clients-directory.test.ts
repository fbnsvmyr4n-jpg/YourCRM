import { describe, expect, it } from "vitest";
import { groupByOwner, type Owner } from "../src/server/clients-view";
import { groupByDepartment } from "../src/server/directory";

/**
 * Who is looking after whom, and who works here.
 *
 * Both screens are a grouping and an ordering over rows the database already
 * holds, so the grouping and the ordering ARE the feature and are what is
 * tested. The fixture is small enough that every expected answer below was
 * worked out by hand first — the method that found the 0.5% loss rate and the
 * "0 of 11 leads captured", rather than asserting whatever the code returns.
 */

/* Five contacts, three owners, one of them a stranger. Money chosen so no two
   totals are equal — a fixture where every figure is 100 cannot tell a correct
   sum from a wrong one. */
const rows = [
  row("c1", "u_sam", "Amara", "Dube", 120_000_00, 0),
  row("c2", "u_sam", "Ben", "Cole", 45_000_00, 30_000_00),
  row("c3", "u_sam", "Cher", "Naidoo", 0, 15_000_00),
  row("c4", "u_nadia", "Gina", "Abrahams", 200_000_00, 0),
  row("c5", null, "Lena", "Ncube", 0, 50_000_00),
];

const people: Owner[] = [
  { id: "u_nadia", name: "Nadia Petrov", jobTitle: "Head of Sales", department: "Sales" },
  { id: "u_sam", name: "Sam Carter", jobTitle: "Account Executive", department: "Sales" },
  { id: "u_thabo", name: "Thabo Mokoena", jobTitle: null, department: "Sales" },
];

function row(
  id: string,
  owner: string | null,
  first: string,
  last: string,
  won: number,
  open: number
) {
  return {
    id,
    owner_user_id: owner,
    first_name: first,
    last_name: last,
    company_name: null,
    email: null,
    phone: null,
    is_client: won > 0,
    has_open_deal: open > 0,
    won_cents: String(won),
    open_cents: String(open),
  };
}

const nameOf = (b: { owner: { name: string } | null }) => b.owner?.name ?? "Unassigned";

describe("grouping a book of business", () => {
  it("puts every contact under the person who owns them", () => {
    const books = groupByOwner(rows, people, "u_sam");
    const sam = books.find((b) => b.owner?.id === "u_sam");
    expect(sam?.entries.map((e) => e.name)).toEqual(["Amara Dube", "Ben Cole", "Cher Naidoo"]);
  });

  it("sums won and open money separately, and counts only those who bought", () => {
    // By hand: won 120,000 + 45,000 = 165,000. Open 30,000 + 15,000 = 45,000.
    // Two of the three have a won deal; Cher has only an open one.
    const sam = groupByOwner(rows, people, "u_sam").find((b) => b.owner?.id === "u_sam");
    expect(sam?.wonValueCents).toBe(165_000_00);
    expect(sam?.openValueCents).toBe(45_000_00);
    expect(sam?.clientCount).toBe(2);
  });

  it("puts the reader first, then everybody else alphabetically", () => {
    expect(groupByOwner(rows, people, "u_sam").map(nameOf)).toEqual([
      "Sam Carter",
      "Nadia Petrov",
      "Thabo Mokoena",
      "Unassigned",
    ]);
  });

  it("orders alphabetically when the reader owns nothing and is not on the team", () => {
    expect(groupByOwner(rows, people, "u_stranger").map(nameOf)).toEqual([
      "Nadia Petrov",
      "Sam Carter",
      "Thabo Mokoena",
      "Unassigned",
    ]);
  });

  it("lists a colleague who has nothing assigned", () => {
    // An empty book is a fact worth seeing — somebody new, or somebody who has
    // just handed everything over. Hiding it would make that invisible.
    const thabo = groupByOwner(rows, people, "u_sam").find((b) => b.owner?.id === "u_thabo");
    expect(thabo).toBeDefined();
    expect(thabo?.entries).toEqual([]);
    expect(thabo?.wonValueCents).toBe(0);
  });

  it("collects unowned contacts into a row of their own, last", () => {
    const books = groupByOwner(rows, people, "u_sam");
    expect(books[books.length - 1].owner).toBeNull();
    expect(books[books.length - 1].entries.map((e) => e.name)).toEqual(["Lena Ncube"]);
  });

  it("omits the unassigned row entirely when there is nothing in it", () => {
    // A row reading "Unassigned — 0" is a problem being reported that does not
    // exist.
    const owned = rows.filter((r) => r.owner_user_id !== null);
    expect(groupByOwner(owned, people, "u_sam").some((b) => b.owner === null)).toBe(false);
  });

  it("treats a contact owned by somebody who has left as unassigned", () => {
    // The id stays on the row after the user is soft-deleted, so it matches
    // nobody in `people`. Falling through to unassigned is the point: those
    // contacts are exactly the ones that need reassigning, and dropping them
    // would hide the problem this screen exists to surface.
    const orphan = [row("c9", "u_departed", "Zoe", "Adams", 0, 0)];
    const books = groupByOwner(orphan, people, "u_sam");
    const unassigned = books.find((b) => b.owner === null);
    expect(unassigned?.entries.map((e) => e.name)).toEqual(["Zoe Adams"]);
  });

  it("converts money out of the strings Postgres returns for BIGINT", () => {
    // Returned as text to avoid precision loss. Left as a string it would
    // concatenate rather than add — "12000" + "4500" is a real defect shape.
    const nadia = groupByOwner(rows, people, "u_sam").find((b) => b.owner?.id === "u_nadia");
    expect(nadia?.wonValueCents).toBe(200_000_00);
    expect(typeof nadia?.wonValueCents).toBe("number");
  });
});

describe("filing the directory by department", () => {
  const staff = [
    { name: "Sam Carter", department: "Sales" },
    { name: "Nadia Petrov", department: "Sales" },
    { name: "Lerato Dlamini", department: "Support" },
    { name: "Ivan Roux", department: null },
    { name: "Demo Owner", department: "  " },
  ];

  it("groups by department, alphabetically", () => {
    expect(groupByDepartment(staff).map((g) => g.department)).toEqual(["Sales", "Support", null]);
  });

  it("puts the unfiled last and never hides them", () => {
    // On the day somebody joins they have no department, and that is exactly
    // who everybody is looking up.
    const unfiled = groupByDepartment(staff).find((g) => g.department === null);
    expect(unfiled?.people.map((p) => p.name)).toEqual(["Demo Owner", "Ivan Roux"]);
  });

  it("treats a blank department as unfiled rather than as its own group", () => {
    expect(groupByDepartment(staff).map((g) => g.department)).not.toContain("  ");
  });

  it("sorts people by name inside each group", () => {
    const sales = groupByDepartment(staff).find((g) => g.department === "Sales");
    expect(sales?.people.map((p) => p.name)).toEqual(["Nadia Petrov", "Sam Carter"]);
  });

  it("keeps two spellings apart, but sorts them together", () => {
    /*
       "Sales" and "sales" stay two groups. Deciding on the customer's behalf
       that they are the same team is the product overruling what somebody
       typed; the fix for a typo belongs in the field, where it is visible.
       Sorting is case-insensitive so at least they sit next to each other and
       the duplication is obvious.
    */
    const mixed = [
      { name: "A", department: "sales" },
      { name: "B", department: "Sales" },
      { name: "C", department: "Admin" },
    ];
    const groups = groupByDepartment(mixed).map((g) => g.department);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toBe("Admin");
    expect(groups.slice(1)).toEqual(expect.arrayContaining(["sales", "Sales"]));
  });

  it("returns nothing for nobody", () => {
    expect(groupByDepartment([])).toEqual([]);
  });
});
