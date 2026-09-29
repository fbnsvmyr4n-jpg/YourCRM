import { isWonStage } from "@/data/pipeline";
import { STAGES, type Stage as StageId } from "./repos/deals";
import type { TenantQuery } from "./tenant";

/**
 * How deals that reached a stage have actually gone.
 *
 * The pipeline board showed what each stage is WORTH and never what any of it
 * was LIKELY to be, which is the question a forecast is made of: R45,000 in
 * Discovery and R25,000 in Demo do not add up to R70,000 of revenue, and
 * nobody running a business thinks they do.
 *
 * Two rules, and the whole honesty of the figure rests on them.
 *
 * **It is measured, never assigned.** No stage carries a percentage somebody
 * typed into a settings page. The rate for Demo is this workspace's own closed
 * deals that reached Demo, divided into the ones that were won. A CRM that
 * ships default probabilities is inventing a forecast and dressing it as data.
 *
 * **A deal whose route was not recorded is not counted.** `stages_reached` is
 * NULL for every deal that existed before the column did, and the temptation
 * is to fill it in from the stage the deal is in now. That would be an
 * invention: a deal already in `won` would look as though it reached `won`
 * without passing through Demo, so Demo would read 0% — a confident, precise,
 * completely fabricated number. NULL rows are excluded, and until enough real
 * ones exist the answer is "not enough history", which is true and useful in a
 * way that 0% is not.
 */

/** Below this many closed deals, a percentage is noise dressed as a fact. */
export const ENOUGH = 5;

export type StageOdds = {
  stage: StageId;
  /** Closed deals (won or lost) whose recorded route reached this stage. */
  decided: number;
  won: number;
  /** 0–100, or null when there is not enough history to say. */
  winRate: number | null;
};

/**
 * Shaped from counts, pure, and exported so the arithmetic is testable without
 * a database — the same split `meeting-analytics.ts` keeps.
 */
export function oddsFrom(rows: { stage: string; decided: number; won: number }[]): StageOdds[] {
  const by = new Map(rows.map((r) => [r.stage, r]));
  return STAGES.map((stage) => {
    const r = by.get(stage);
    const decided = r?.decided ?? 0;
    const won = r?.won ?? 0;
    return {
      stage,
      decided,
      won,
      /* Null, never zero, below the floor. "No data" and "never wins" are
         different claims and only one of them is honest on a new account —
         the same rule every other rate in this product follows. */
      winRate: decided >= ENOUGH ? Math.round((won / decided) * 100) : null,
    };
  });
}

/**
 * What the open pipeline is worth once each deal is weighted by how deals at
 * its stage have actually gone.
 *
 * A deal at a stage with no measured rate contributes NOTHING to the weighted
 * figure and is counted in `unweighted` instead, so the screen can say how
 * much of the pipeline the forecast could not speak for. Silently treating it
 * as zero would understate the forecast; silently treating it as certain would
 * overstate it. Saying which is which is the only honest option.
 */
export function weightedPipeline(
  open: { stage: StageId; valueCents: number }[],
  odds: StageOdds[]
): { weightedCents: number; unweightedCents: number } {
  const rate = new Map(odds.map((o) => [o.stage, o.winRate]));
  let weightedCents = 0;
  let unweightedCents = 0;
  for (const deal of open) {
    const pct = rate.get(deal.stage) ?? null;
    if (pct === null) unweightedCents += deal.valueCents;
    else weightedCents += Math.round((deal.valueCents * pct) / 100);
  }
  return { weightedCents, unweightedCents };
}

/**
 * The counts behind the rates, from this workspace's own closed deals.
 *
 * `unnest` turns each deal's route into one row per stage it reached, so a
 * deal that went Prospect → Discovery → Demo → Won counts once in each of
 * those three. That is what "of the deals that reached Demo" means: a deal
 * that never got there has no bearing on how Demo performs.
 *
 * Only CLOSED deals: one still open has not gone either way yet, and counting
 * it as a loss would make every stage's rate fall each time a deal was added —
 * the arithmetic error the deal pipeline already had once.
 */
export async function stageOdds(q: TenantQuery): Promise<StageOdds[]> {
  const rows = await q.rows<{ stage: string; decided: string; won: string }>(
    `SELECT s.stage,
            count(*)::text AS decided,
            count(*) FILTER (WHERE d.won_at IS NOT NULL)::text AS won
       FROM deals d
       CROSS JOIN LATERAL unnest(d.stages_reached) AS s(stage)
      WHERE d.sub_account_id = $1
        AND d.deleted_at IS NULL
        -- Belt and braces, and worth being honest about which is which:
        -- an untracked deal is already excluded by the join, because
        -- unnest(NULL) produces no rows at all. Mutation testing proved it —
        -- removing this line changes no result. It stays because the rule it
        -- states is the whole basis of the figure, and a reader should not
        -- have to know that unnest quirk to see that untracked deals are out.
        AND d.stages_reached IS NOT NULL
        AND (d.won_at IS NOT NULL OR d.stage = 'lost')
      GROUP BY s.stage`,
    [q.ctx.subAccountId]
  );
  return oddsFrom(rows.map((r) => ({ stage: r.stage, decided: Number(r.decided), won: Number(r.won) })));
}

/**
 * The stages a forecast is about.
 *
 * `won`, `delivery` and `referral` are already won and `lost` is already lost,
 * so a rate on any of them answers nothing — the deal's outcome is the thing
 * being predicted. Only the stages a deal can still go either way from.
 */
export const FORECAST_STAGES: readonly StageId[] = STAGES.filter(
  (s) => s !== "lost" && !isWonStage(s)
);
