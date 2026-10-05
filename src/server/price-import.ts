/**
 * Reading a supplier's price list out of whatever they sent.
 *
 * A supplier emails a PDF, or a spreadsheet, or types the prices into the body
 * of a message. Nobody is going to retype forty rows into a form, and a product
 * that asks them to is a product whose prices are six months old. So this takes
 * the lot, pasted or dropped in, and works out what it says.
 *
 * ── The rule that shapes all of it ────────────────────────────────────────
 *
 * A line it cannot read is REPORTED, never skipped. This is a price list: a row
 * silently dropped is a rate somebody quotes from memory next month, and a
 * mis-read number is worse than a missing one because it looks finished. Every
 * line of the input comes back in exactly one bucket, and the screen shows the
 * unreadable ones beside the rest with the line as it arrived.
 *
 * Pure, and deliberately so. No database, no tenant, no `fetch` — which is what
 * lets `price-import.test.ts` throw real supplier formats at it by the dozen,
 * and what makes the answer to "why did it read 1,800 as the price" something
 * you can sit down and check.
 */

/** A row the parser understood. Cents, like every other amount in this product. */
export type ParsedLine = {
  name: string;
  unit: string;
  unitCents: number;
  /** The line exactly as it arrived, so the screen can show what it read. */
  source: string;
};

/** A row it could not read, and the honest reason. */
export type UnreadLine = { source: string; reason: string };

export type ParsedList = { lines: ParsedLine[]; unread: UnreadLine[] };

/**
 * What a number looks like once the thousands separators are gone.
 *
 * Suppliers write 1 800,00 and 1,800.00 and R1 800 and 1800. The decimal mark
 * is whichever of `.` or `,` comes LAST — "1,800.00" is eighteen hundred and
 * "1.800,00" is also eighteen hundred, and the only thing that tells them apart
 * is which separator is nearer the end.
 */
export function readAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, "");
  if (!cleaned || !/\d/.test(cleaned)) return null;

  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let normalised: string;
  if (lastDot === -1 && lastComma === -1) {
    normalised = cleaned;
  } else {
    const decimalAt = Math.max(lastDot, lastComma);
    const whole = cleaned.slice(0, decimalAt).replace(/[.,]/g, "");
    const fraction = cleaned.slice(decimalAt + 1).replace(/[.,]/g, "");
    /*
       Three digits after the mark means it was a thousands separator, not a
       decimal point: "1,800" is eighteen hundred, not one and eight tenths.
       Two or fewer means cents. More than three is not money.
    */
    if (fraction.length === 3) normalised = whole + fraction;
    else if (fraction.length <= 2) normalised = `${whole}.${fraction}`;
    else return null;
  }

  const n = Number(normalised);
  if (!Number.isFinite(n) || n < 0) return null;
  /* A hundred million a unit is not a price, it is a misread column. */
  if (n > 100_000_000) return null;
  return Math.round(n * 100);
}

/**
 * Which pieces a line is made of.
 *
 * Tabs first, because anything pasted out of a spreadsheet has them and they
 * are unambiguous. Then two-or-more spaces, which is what a PDF column gap
 * becomes. A single space is NOT a separator — "Paving stone 50mm" is one
 * field, and splitting on it would turn every product name into three columns.
 */
function columns(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  if (/ {2,}/.test(line)) return line.split(/ {2,}/).map((c) => c.trim());

  /*
     A COMMA BETWEEN TWO DIGITS IS PART OF THE NUMBER. Every other comma
     separates.

     This is the one that bit, and it bit silently. Splitting on every comma
     turned

         Rebar Y12 ton 14,500.00

     into ["Rebar Y12 ton 14", "500.00"] and loaded rebar at FIVE HUNDRED rand
     a ton instead of fourteen and a half thousand. A plausible name, a
     plausible price, no warning — and every quotation built on it out by
     fourteen thousand rand a ton. Found by driving the real screen.

     Masking the number commas first, rather than a lookbehind, says exactly
     that and keeps working on the older regex target this project compiles to.
     It handles the European decimal for free: "450,00" is digits either side,
     so it is a number too.
  */
  const GUARD = "\u0000";
  /* A replacer function rather than a `$1` string: this project's own guard
     test forbids a literal `$` beside an amount, and its failure log already
     records `$$` and `$'` in replacement strings biting twice. */
  const masked = line.replace(/(\d),(\d)/g, (_m, before: string, after: string) => before + GUARD + after);
  if (masked.includes(",")) {
    return masked.split(",").map((c) => c.split(GUARD).join(",").trim());
  }

  /*
     One column, because the columns were spaces and the paste collapsed them.

     Plain-text email does this constantly. Rather than give up — which would
     report most of a real list as unreadable — the trailing amount is peeled
     off the end, and then a unit word behind it. Anchored at the END so a
     number inside a name ("Stone 50mm") is never mistaken for the price.
  */
  const tail = /^(.*?)\s+((?:[A-Za-z²³]{1,14})\s+)?((?:[A-Z]{1,3}\s*)?[\d][\d .,]*)$/.exec(line.trim());
  if (tail) {
    const [, name, unit, amount] = tail;
    return [name.trim(), ...(unit ? [unit.trim()] : []), amount.trim()].filter(Boolean);
  }

  return [line.trim()];
}

/** Units a supplier actually writes, for telling a unit apart from a name. */
const UNIT_WORDS =
  /^(each|ea|unit|item|hour|hr|day|week|month|m|m2|m²|m3|m³|mm|cm|km|kg|g|ton|tonne|t|l|litre|liter|ml|pack|box|bag|roll|sheet|pair|set|lot|load|trip|visit|per .+)$/i;

const looksLikeUnit = (value: string) => value.length <= 14 && UNIT_WORDS.test(value.trim());

/**
 * A heading row rather than a price.
 *
 * Supplier lists arrive with their own headers, and a row called "Description /
 * Unit / Price" parsed as a product would put a line called "Description" into
 * somebody's quotation.
 */
const HEADING = /^(description|item|product|service|material|name|unit|uom|price|rate|cost|amount|qty|quantity|ex vat|incl vat|vat)$/i;

function isHeading(cols: string[]): boolean {
  const words = cols.filter(Boolean);
  if (words.length > 1 && words.every((c) => HEADING.test(c))) return true;
  /*
     And when the columns collapsed to single spaces, so the header arrived as
     one field: "Description Unit Price". Checked on the words because
     otherwise a heading is reported as unreadable on EVERY import from a
     plain-text list — which is the noise that teaches people to stop reading
     the unreadable-lines box, and that box is the whole safety net here.
  */
  if (words.length === 1) {
    const parts = words[0].split(/\s+/).filter(Boolean);
    return parts.length > 1 && parts.every((p) => HEADING.test(p));
  }
  return false;
}

/**
 * Read a pasted or dropped price list.
 *
 * Takes the text exactly as it arrived. Blank lines are not "unread" — they are
 * nothing, and reporting them as failures would bury the lines that genuinely
 * could not be read under the empty ones between sections.
 */
export function parsePriceList(input: string): ParsedList {
  const lines: ParsedLine[] = [];
  const unread: UnreadLine[] = [];

  for (const raw of input.split(/\r?\n/)) {
    const source = raw.trim();
    if (!source) continue;

    const cols = columns(raw);
    if (isHeading(cols)) continue;

    /*
       The price is the LAST column that reads as money.

       Searched from the right because a product name can contain a number —
       "Paving stone 50mm", "Rebar Y12" — and taking the first number found
       would price the paving at 50mm. A list with both an ex-VAT and an
       incl-VAT column also puts the one we want... ambiguously, which is why
       the preview shows what was read and asks somebody to look.
    */
    let priceAt = -1;
    let unitCents: number | null = null;
    for (let i = cols.length - 1; i >= 1; i--) {
      const amount = readAmount(cols[i]);
      if (amount !== null && /\d/.test(cols[i])) {
        priceAt = i;
        unitCents = amount;
        break;
      }
    }

    if (priceAt === -1 || unitCents === null) {
      unread.push({ source, reason: "no price on this line" });
      continue;
    }
    if (unitCents === 0) {
      unread.push({ source, reason: "the price reads as zero" });
      continue;
    }

    /* Whatever sits between the name and the price, when it looks like a unit.
       Anything else stays part of the name rather than being thrown away. */
    const before = cols.slice(0, priceAt).filter(Boolean);
    let unit = "each";
    let nameParts = before;
    const last = before[before.length - 1];
    if (before.length > 1 && last && looksLikeUnit(last)) {
      unit = last.trim();
      nameParts = before.slice(0, -1);
    }

    const name = nameParts.join(" ").replace(/\s+/g, " ").trim();
    if (!name) {
      unread.push({ source, reason: "a price with nothing named against it" });
      continue;
    }
    if (name.length > 120) {
      unread.push({ source, reason: "the name is too long to be one" });
      continue;
    }

    lines.push({ name, unit: unit.slice(0, 24), unitCents, source });
  }

  return { lines, unread };
}

/* ------------------------------------------------------------------ */
/* What applying it would do                                           */
/* ------------------------------------------------------------------ */

/** An item already on the list, as far as the diff is concerned. */
export type ExistingItem = { id: string; name: string; unitCents: number };

export type PriceChange =
  | { kind: "new"; line: ParsedLine }
  | { kind: "changed"; line: ParsedLine; id: string; fromCents: number }
  | { kind: "same"; line: ParsedLine; id: string };

/**
 * What this paste would actually DO, before it does it.
 *
 * Shown and confirmed rather than applied on sight. A price list is what every
 * quotation is built from: pasting the wrong column, or last year's file,
 * silently re-prices the whole business. "47 new, 12 changed, 3 we could not
 * read" is a sentence somebody can check in five seconds.
 *
 * Matched on the name, case- and space-insensitively, because that is what a
 * supplier's list and this list have in common — there is no shared id and
 * never will be.
 */
export function planChanges(parsed: ParsedLine[], existing: ExistingItem[]): PriceChange[] {
  const key = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();
  const byName = new Map(existing.map((e) => [key(e.name), e]));

  return parsed.map((line) => {
    const match = byName.get(key(line.name));
    if (!match) return { kind: "new", line };
    if (match.unitCents === line.unitCents) return { kind: "same", line, id: match.id };
    return { kind: "changed", line, id: match.id, fromCents: match.unitCents };
  });
}

/** The one-line summary the confirm button is pressed against. */
export function describeChanges(changes: PriceChange[], unread: number): string {
  const counts = {
    new: changes.filter((c) => c.kind === "new").length,
    changed: changes.filter((c) => c.kind === "changed").length,
    same: changes.filter((c) => c.kind === "same").length,
  };
  const parts: string[] = [];
  if (counts.new) parts.push(`${counts.new} new`);
  if (counts.changed) parts.push(`${counts.changed} with a new price`);
  if (counts.same) parts.push(`${counts.same} unchanged`);
  if (unread) parts.push(`${unread} we could not read`);
  return parts.length ? parts.join(", ") : "nothing to apply";
}
