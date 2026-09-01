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

/**
 * The same idea for a plain list of strings.
 *
 * The meeting form has three free-text boxes — topic, participant email and
 * meeting link — and every one of them is usually something typed before. A
 * topic repeats across a week of follow-ups, a link is normally the one
 * standing room, and an address belongs to somebody already on file.
 *
 * Case-insensitive, every typed word must appear, and a value that STARTS with
 * what was typed ranks above one that merely contains it — so two letters reach
 * the thing meant rather than the first match in insertion order. Duplicates
 * are dropped: the same topic used ten times is one suggestion, not ten.
 */
export function matchStrings(options: readonly string[], query: string, limit = 6): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const o of options) {
    const key = o.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(o.trim());
  }

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  /* An empty query offers the list as it stands — for these fields that is the
     useful thing, since "what did I use last time" is the whole question. */
  if (terms.length === 0) return unique.slice(0, limit);

  const first = terms[0];
  return unique
    .filter((o) => {
      const hay = o.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .map((o, i) => ({ o, r: o.toLowerCase().startsWith(first) ? 0 : 1, i }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.o);
}
