import type { Person } from "@/components/ui/PersonField";

/** What a query is matched against — name, company and address, as one string. */
function haystack(p: Person): string {
  return `${p.name} ${p.company} ${p.email}`.toLowerCase();
}

/**
 * Whether every word typed appears somewhere in this person's details.
 *
 * Every word, not the whole string. A single `includes` over the joined text
 * only matches the order it happens to be stored in: "kobus steyn" found him
 * and "steyn kobus" found nobody, which is the kind of failure that reads as
 * "he isn't in here" rather than "you typed his name backwards". Splitting on
 * whitespace also lets a surname and a company narrow together — "abrahams
 * tile" reaches one person where either word alone reaches several.
 */
function matchesAllTerms(p: Person, terms: string[]): boolean {
  const hay = haystack(p);
  return terms.every((t) => hay.includes(t));
}

/**
 * How strongly a person answers the query, lower being better.
 *
 * Someone whose name STARTS with what was typed is almost always who was meant
 * — typing "ni" should reach Nadia before it reaches Gina Abrahams, whose
 * company contains an "ni". Ranking by where the match falls rather than only
 * whether it exists is what makes a short query usable.
 */
function rank(p: Person, first: string): number {
  const name = p.name.toLowerCase();
  if (name.startsWith(first)) return 0;
  // The start of any word in the name — a surname typed on its own.
  if (name.split(/\s+/).some((w) => w.startsWith(first))) return 1;
  if (p.email.toLowerCase().startsWith(first)) return 2;
  if (p.company.toLowerCase().startsWith(first)) return 3;
  return 4;
}

/**
 * The people a query is asking for, best first.
 *
 * Pure, and separate from the field that renders it, because this is the part
 * worth testing directly: the ordering rules are easy to state and easy to get
 * subtly wrong, and a DOM test would only ever prove that some list appeared.
 *
 * Ties keep the order they arrived in. The inbox hands them over most recently
 * messaged first, so an ambiguous query resolves towards the person actually
 * being corresponded with rather than whoever the database returns first.
 */
export function matchPeople(people: Person[], query: string, limit = 6): Person[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const first = terms[0];
  return people
    .filter((p) => matchesAllTerms(p, terms))
    .map((p, i) => ({ p, r: rank(p, first), i }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.p);
}
