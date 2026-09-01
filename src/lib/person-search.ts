import type { Person } from "@/components/ui/PersonField";

/**
 * Lowercased and stripped of accents, so what is typed reaches what is stored.
 *
 * A keyboard rarely produces the accent that a name is filed under: someone
 * looking for "José Müller" types "jose muller" and, matched literally, finds
 * nobody — the CRM appearing not to hold a contact it holds. Normalising both
 * sides is the difference between a search that works for every name and one
 * that works for the unaccented ones.
 */
export function normalise(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** What a query is matched against — name, company and address, as one string. */
function haystack(p: Person): string {
  return normalise(`${p.name} ${p.company} ${p.email}`);
}

/**
 * The first letter of each word of a name, so "ad" reaches "Amara Dube".
 *
 * How people actually reach for someone they know: two letters, not a prefix.
 * Deliberately narrow — only a short query with no spaces is read this way, or
 * every two-letter substring would start dragging in half the address book.
 */
function initials(name: string): string {
  return normalise(name)
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("");
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
  const name = normalise(p.name);
  if (name.startsWith(first)) return 0;
  // The start of any word in the name — a surname typed on its own.
  if (name.split(/\s+/).some((w) => w.startsWith(first))) return 1;
  if (normalise(p.email).startsWith(first)) return 2;
  if (normalise(p.company).startsWith(first)) return 3;
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
  const terms = normalise(query.trim()).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const first = terms[0];

  /**
   * Initials only for a single-word query. "ad" means Amara Dube; "ad roofing"
   * means two words that must both appear, and reading the first as initials
   * would widen the list exactly when the reader is narrowing it.
   *
   * No length bounds: a one-letter query already matches every such name
   * literally, and a long one would need a name of that many words. Both were
   * guarded here and neither guard could change an answer, so they are gone
   * rather than sitting untested.
   */
  const asInitials = terms.length === 1;

  return people
    .filter((p) => matchesAllTerms(p, terms) || (asInitials && initials(p.name).startsWith(first)))
    .map((p, i) => ({
      p,
      /* An initials hit that matched nothing else sorts just under a real
         name prefix: useful, but never ahead of someone actually spelt that
         way. */
      r: matchesAllTerms(p, terms) ? rank(p, first) : 1.5,
      i,
    }))
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
  /**
   * Deduplicated, and counted while deduplicating.
   *
   * How OFTEN something was used is the strongest signal these fields have.
   * A standing meeting room appears on twenty meetings and a one-off link on
   * one; offering them in date order puts the one-off first purely because it
   * happened to be typed last. Counting costs nothing here — the duplicates
   * have to be walked anyway — and turns "what did I use" into "what do I
   * always use".
   */
  const index = new Map<string, { value: string; count: number; first: number }>();
  options.forEach((o, i) => {
    const value = o.trim();
    if (!value) return;
    const key = normalise(value);
    const seen = index.get(key);
    if (seen) seen.count += 1;
    else index.set(key, { value, count: 1, first: i });
  });
  const unique = [...index.values()];

  /* Most used first, and the more recent of two equals — the caller hands
     these over newest first, so a lower index is the newer one. */
  const byUse = (a: (typeof unique)[number], b: (typeof unique)[number]) =>
    b.count - a.count || a.first - b.first;

  const terms = normalise(query.trim()).split(/\s+/).filter(Boolean);
  /* An empty query offers the list as it stands — for these fields that is the
     useful thing, since "what did I use last time" is the whole question. */
  if (terms.length === 0) return [...unique].sort(byUse).slice(0, limit).map((u) => u.value);

  const first = terms[0];
  return unique
    .filter((u) => {
      const hay = normalise(u.value);
      return terms.every((t) => hay.includes(t));
    })
    .map((u) => ({ u, r: normalise(u.value).startsWith(first) ? 0 : 1 }))
    .sort((a, b) => a.r - b.r || byUse(a.u, b.u))
    .slice(0, limit)
    .map((x) => x.u.value);
}

/**
 * Where each typed word falls inside a suggestion, merged and in order.
 *
 * So the list can show WHY a row is in it. Scanning six near-identical
 * conferencing links for the one that answers what you typed is real work; the
 * matched run makes the answer obvious without reading the whole string.
 *
 * Ranges are merged because two typed words can overlap in the text — "meet
 * meeting" would otherwise produce a highlight inside a highlight and split the
 * string into fragments that no longer read as the original.
 */
export function matchRanges(text: string, query: string): Array<[number, number]> {
  const hay = normalise(text);
  const terms = normalise(query.trim()).split(/\s+/).filter(Boolean);
  const hits: Array<[number, number]> = [];
  for (const t of terms) {
    /* Every occurrence, not just the first: a term can appear in both the name
       and the address, and highlighting one of them looks like a near miss. */
    let at = hay.indexOf(t);
    while (at !== -1) {
      hits.push([at, at + t.length]);
      at = hay.indexOf(t, at + t.length);
    }
  }
  /**
   * Nothing matched literally, so this row is here on its initials — mark
   * those instead.
   *
   * Without it a contact reached by typing "ad" appears among rows that all
   * show a highlighted "ad" while itself showing none, which reads as an
   * arbitrary extra result rather than the deliberate one it is.
   */
  if (hits.length === 0) {
    if (terms.length !== 1) return [];
    const q = terms[0];
    const starts: number[] = [];
    const wordStart = /(?:^|\s)\S/g;
    let m: RegExpExecArray | null;
    while ((m = wordStart.exec(hay))) starts.push(m.index + m[0].length - 1);
    if (starts.length < q.length) return [];
    const picked = starts.slice(0, q.length);
    if (!picked.every((at, i) => hay[at] === q[i])) return [];
    return picked.map((at) => [at, at + 1] as [number, number]);
  }

  hits.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [hits[0]];
  for (const [start, end] of hits.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
