import { STAGES as STAGE_IDS, type Stage as StageId } from "@/server/repos/deals";

/**
 * The pipeline as it is shown on screen.
 *
 * The columns this replaces — Leads In → Qualified → Proposals → Negotiations →
 * Closed Won — were invented, not derived from how anyone actually sells. The
 * audit's instruction was to replace them with Bradley's documented process,
 * and the difference is not cosmetic: the old board ended at the sale, so
 * Delivery and Referral had nowhere to exist, and a lost deal had no state at
 * all, which made Win Rate arithmetically wrong.
 *
 * Each stage carries its **exit condition** rather than a description. The
 * question a board has to answer is "what has to happen for this card to
 * move", and a hint that restates the label does not answer it.
 *
 * Ids and their order come from the repository's `STAGES`, so a stage cannot
 * exist here that the database would reject.
 */

export type StageMeta = {
  id: StageId;
  label: string;
  color: string;
  soft: string;
  /** What has to be true for a card to leave this column. */
  exit: string;
};

const META: Record<StageId, Omit<StageMeta, "id">> = {
  prospect: {
    label: "Prospect",
    color: "var(--accent)",
    soft: "var(--accent-soft)",
    exit: "Exits when a meeting is booked",
  },
  discovery: {
    label: "Discovery",
    color: "var(--purple)",
    soft: "var(--purple-soft)",
    // Qualifying, explicitly not selling — and the pain points captured here
    // are what the demo is built from.
    exit: "Exits when qualified — capture their pain points",
  },
  demo: {
    label: "Demo",
    color: "var(--amber)",
    soft: "var(--amber-soft)",
    exit: "Exits when the value case is made against those pains",
  },
  won: {
    label: "Closed Won",
    color: "var(--green)",
    soft: "var(--green-soft)",
    exit: "Exits on payment",
  },
  delivery: {
    label: "Delivery",
    color: "#0ea5e9",
    soft: "rgba(14,165,233,0.12)",
    exit: "Exits when the client is verifiably happy",
  },
  referral: {
    label: "Referral",
    color: "#f97316",
    soft: "rgba(249,115,22,0.12)",
    exit: "Feeds back into Prospect",
  },
  lost: {
    label: "Lost",
    color: "var(--red)",
    soft: "var(--red-soft)",
    exit: "Terminal — reopening clears the reason",
  },
};

/**
 * The six columns the board shows.
 *
 * `lost` is deliberately not among them. It is a real stage and the reason Win
 * Rate can be computed at all, but a column of dead deals sitting permanently
 * beside live work is clutter that gets ignored — so lost deals are counted and
 * reachable, not displayed alongside the pipeline.
 */
export const BOARD_STAGES: StageMeta[] = STAGE_IDS.filter((id) => id !== "lost").map((id) => ({
  id,
  ...META[id],
}));

export const stageMeta = (id: StageId): StageMeta => ({ id, ...META[id] });

/**
 * Stages where a figure on the card means something.
 *
 * A prospect nobody has spoken to has no value worth showing; inventing one
 * puts imaginary money in the pipeline total. Discovery is the first point at
 * which anybody could name a number.
 */
export const MONEY_STAGES: readonly StageId[] = ["discovery", "demo", "won", "delivery", "referral"];

export const carriesMoney = (stage: StageId) => MONEY_STAGES.includes(stage);

/** Won-ness is a fact recorded on the deal, never a position on the board. */
export const isWonStage = (stage: StageId) => stage === "won" || stage === "delivery" || stage === "referral";
