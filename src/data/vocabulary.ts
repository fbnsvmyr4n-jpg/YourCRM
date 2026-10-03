/*
   TYPE-ONLY, and that matters.

   `repos/settings` reads this file for the default, and `repos/deals` reads
   settings to pick a job's prefix — so a RUNTIME import of the deals repo here
   closes a cycle: deals → settings → vocabulary → deals. A circular import does
   not fail loudly; it leaves one module half-initialised depending on which was
   loaded first, and what that looked like was a retainer test failing somewhere
   else entirely.

   A type import is erased at compile time, so the stage ids still come from the
   repository — a stage cannot exist here that the database would reject — and
   nothing is imported at run time. The order below comes from the record's own
   keys instead.
*/
import type { Stage as StageId } from "@/server/repos/deals";

/**
 * What a workspace calls its own work.
 *
 * The pipeline was written in one industry's language — Prospect, Discovery,
 * Demo, with "Exits when the value case is made against those pains" — and that
 * language is correct for a sales team and meaningless to a paving contractor,
 * who does not demo anything. The columns describe the same seven states either
 * way: somebody enquired, you went and looked, you put a price on it, they said
 * yes, you did the work.
 *
 * So this is WORDS ONLY. The stage ids are unchanged, the database is
 * unchanged, every report and every automation keeps working, and a workspace
 * that switches has nothing to migrate. What changes is what the screens say.
 *
 * Two of them, because two is what this product is for: a sales team and a
 * trades business. Inventing five would be breadth nobody asked for and four
 * sets of words nobody checked.
 */

export const VOCABULARIES = ["sales", "trades"] as const;
export type VocabularyId = (typeof VOCABULARIES)[number];

export const DEFAULT_VOCABULARY: VocabularyId = "sales";

export type Words = {
  /** How this workspace is described when choosing. */
  name: string;
  blurb: string;
  /** One piece of work, and many. "Deal" / "Job". */
  one: string;
  many: string;
  /** The sidebar area that LISTS them, grouped by who they are for. */
  area: string;
  /**
   * The stage BOARD, which is a different screen from the list above.
   *
   * Both would be "Jobs" in a trades workspace, and two identical rows in one
   * sidebar is a worse answer than either word on its own — so the board is
   * named after what it shows rather than after what is on it.
   */
  board: string;
  /** What the party on a document is called: a client, or a customer. */
  client: string;
  /** The reference printed on a piece of work: D-1001, J-1001. */
  prefix: string;
  /** The seven stages, by id, in this workspace's language. */
  stages: Record<StageId, { label: string; exit: string }>;
};

const SALES: Words = {
  name: "Sales team",
  blurb: "Prospect, discovery, demo — selling a product or a service.",
  one: "Deal",
  many: "Deals",
  area: "Projects",
  board: "Deals",
  client: "Client",
  prefix: "D",
  stages: {
    prospect: { label: "Prospect", exit: "Exits when a meeting is booked" },
    discovery: { label: "Discovery", exit: "Exits when qualified — capture their pain points" },
    demo: { label: "Demo", exit: "Exits when the value case is made against those pains" },
    won: { label: "Closed Won", exit: "Won and counted — exits when delivery starts" },
    delivery: { label: "Delivery", exit: "Exits when the client is verifiably happy" },
    referral: { label: "Referral", exit: "Feeds back into Prospect" },
    lost: { label: "Lost", exit: "Terminal — reopening clears the reason" },
  },
};

/**
 * The same seven states, in the words a contractor actually uses.
 *
 * Each one is a real step on a job rather than a translation of the sales word
 * above it: you go and look before you can price it, and the thing that moves a
 * job out of "Quoted" is the client accepting the price — not a value case.
 */
const TRADES: Words = {
  name: "Trades & site work",
  blurb: "Enquiry, site visit, quote, out on site — work you price and deliver.",
  one: "Job",
  many: "Jobs",
  area: "Jobs",
  board: "Pipeline",
  client: "Customer",
  prefix: "J",
  stages: {
    prospect: { label: "Enquiry", exit: "Exits when a site visit is booked" },
    discovery: { label: "Site visit", exit: "Exits when you know the scope — capture what they need" },
    demo: { label: "Quoted", exit: "Exits when the customer accepts the price" },
    won: { label: "Won", exit: "Won and counted — exits when work starts" },
    delivery: { label: "On site", exit: "Exits when the work is signed off" },
    referral: { label: "Referral", exit: "Feeds back into Enquiry" },
    lost: { label: "Lost", exit: "Terminal — reopening clears the reason" },
  },
};

const BY_ID: Record<VocabularyId, Words> = { sales: SALES, trades: TRADES };

/**
 * The words for a workspace, falling back to the sales set.
 *
 * `?? SALES` for the same fail-safe reason as the permission tables: the value
 * arrives from a database column and is whatever is in that column. A workspace
 * saved by a newer build must read in the old one's language rather than render
 * a screen full of `undefined`.
 */
export function wordsFor(vocabulary: string | null | undefined): Words {
  return BY_ID[(vocabulary ?? "") as VocabularyId] ?? SALES;
}

export function isVocabulary(value: unknown): value is VocabularyId {
  return (VOCABULARIES as readonly unknown[]).includes(value);
}

/**
 * Every stage, in board order, with the words for this workspace.
 *
 * Ordered by the record's own keys rather than by the repository's array, so
 * this file needs nothing from the deals module at run time — see the note on
 * the import. Both sets are written in the same order, and `vocabulary.test.ts`
 * holds them to the repository's.
 */
export function stagesFor(vocabulary: string | null | undefined) {
  const words = wordsFor(vocabulary);
  return (Object.keys(words.stages) as StageId[]).map((id) => ({ id, ...words.stages[id] }));
}
