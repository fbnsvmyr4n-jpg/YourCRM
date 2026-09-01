import { matchRanges } from "@/lib/person-search";

/**
 * A suggestion with the part that answered the query picked out.
 *
 * Six conferencing links differ by a few characters in the middle, and six
 * contacts from the same firm differ by a first name; finding which row answers
 * what was typed means reading all of them. Emphasising the matched run turns
 * that into a glance.
 *
 * Weight, not colour. The rows already use colour for selection and the accent
 * carries meaning elsewhere in this app; a second colour here would compete
 * with both, and weight survives whatever the theme is doing.
 */
export function HighlightedMatch({ text, query }: { text: string; query: string }) {
  const ranges = matchRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    /* Sliced from the ORIGINAL text, never the normalised copy — the accents
       belong on screen even though they were ignored while matching. */
    parts.push(
      <mark key={i} className="bg-transparent font-semibold text-[var(--text)]">
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));

  return <>{parts}</>;
}
