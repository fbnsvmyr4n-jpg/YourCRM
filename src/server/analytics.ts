import type { TenantQuery } from "./tenant";
import { STAGES, SOURCES, type Source, type Stage } from "./repos/deals";
import { meetingStats, type MeetingStats } from "./repos/meetings";

/**
 * Every figure the Reports page shows, computed in one place.
 *
 * Two rules, both carried over because both were earned:
 *
 *  - **Only report what the records say.** Nothing here estimates, forecasts or
 *    fills a gap. Where the data cannot answer a question the shape says so —
 *    a `null` rate — and the page renders that rather than a confident zero.
 *  - **The page stays a view.** It used to derive figures inline, which is how
 *    it came to report three of the four lead sources.
 *
 * Two things changed with the relational schema.
 *
 * The old `attribution` block is **gone**. It existed because won deals were
 * matched to leads *by name* to discover their source, and only 4 of 10
 * matched, so the report had to carry an `unattributed` bucket and a caveat
 * explaining itself. `source` is now a column on the deal. Every won deal has
 * one, the caveat has nothing left to describe, and the bucket it needed no
 * longer exists.
 *
 * Colours are not here either. They are presentation, and a data layer that
 * hands out CSS variables cannot be tested without knowing what a chart looks
 * like. The page maps a stage or a source to a colour; this module says what
 * happened.
 *
 * Counted in SQL rather than by loading rows and reducing them. Pulling every
 * deal into memory to add up a column was the JSONB path's defining cost, and
 * it grows with the customer.
 */

/** Stages that mean the money is real. Delivery and Referral are post-close. */
const WON_STAGES = ["won", "delivery", "referral"] as const;
/** Stages where a deal is still being worked. */
const OPEN_STAGES = ["prospect", "discovery", "demo"] as const;

export type SourceRow = {
  source: Source;
  /** Every deal that arrived from this source, whatever became of it. */
  deals: number;
  wonDeals: number;
  wonCents: number;
};

export type StageRow = {
  stage: Stage;
  count: number;
  valueCents: number;
};

export type ReportData = {
  revenue: {
    /** Won revenue, all time, from deals with a recorded `won_at`. */
    wonCents: number;
    wonCount: number;
    /** Still in play: the three pre-close stages only. */
    openPipelineCents: number;
    openCount: number;
    /** Null with no won deals — an average of nothing is not zero. */
    avgWonDealCents: number | null;
  };
  /**
   * Won as a share of *decided* deals.
   *
   * Won ÷ all deals was the old formula and it is arithmetically wrong: it fell
   * every time a lead was added, because deals still in progress counted as
   * losses. Null until something has actually been decided.
   */
  winRate: number | null;
  byStage: StageRow[];
  bySource: SourceRow[];
  /** Why deals died, from the reason `moveStage` insists on. */
  lossReasons: { reason: string; count: number }[];
  /** Won revenue per week, most recent last, for the trend line. */
  weekly: { weekStart: string; wonCents: number }[];
  meetings: MeetingStats;
  contacts: {
    total: number;
    /** Has a won deal. */
    clients: number;
    /** Has an open deal — the new definition of a lead. */
    leads: number;
  };
  /** Only meaningful with more than one owner; empty otherwise. */
  owners: { ownerUserId: string; name: string; wonCount: number; wonCents: number }[];
  /** What the voice agent has actually done. Counts of stored records, not rates. */
  voice: {
    calls: number;
    /** Calls carrying a deal id, i.e. ones that produced an opportunity. */
    producedDeal: number;
    totalSeconds: number;
    avgSeconds: number | null;
  };
};

const n = (v: string | number | null | undefined): number => (v == null ? 0 : Number(v));

/**
 * A window to report over, as a SQL fragment plus its parameters.
 *
 * Applied ONLY to figures that are about a period. Open Pipeline, deals by
 * stage and contact counts are point-in-time facts — what is true now — and
 * "Open Pipeline for July" is not a number that exists. Filtering them by a
 * date would produce something that looks like a figure and is not one, which
 * is the failure this codebase keeps finding.
 */
export type ReportWindow = { from: Date | null; to: Date | null };

const wonWithin = (w: ReportWindow, next: number): { sql: string; params: (Date)[] } => {
  if (!w.from || !w.to) return { sql: "", params: [] };
  // Half-open: a deal won at exactly midnight on the 1st belongs to one month,
  // not to both.
  return { sql: ` AND won_at >= $${next} AND won_at < $${next + 1}`, params: [w.from, w.to] };
};

export async function reportData(
  q: TenantQuery,
  window: ReportWindow = { from: null, to: null }
): Promise<ReportData> {
  const tenant = q.ctx.subAccountId;
  const won = wonWithin(window, 3);

  /**
   * Issued one at a time, deliberately.
   *
   * `Promise.all` here fired nine queries at a single pooled client inside one
   * transaction, and a `pg` client is not concurrency-safe: it warns
   * ("client.query() when the client is already executing a query"), serialises
   * them anyway, and stops working in pg@9. So the parallelism was never real —
   * it only looked like it in the source. Awaiting each one says what actually
   * happens, and these are indexed aggregates over one tenant, not table scans.
   */
  const totals = await q.one<{
        won_cents: string;
        won_count: string;
        open_cents: string;
        open_count: string;
        lost_count: string;
      }>(
        /**
         * Won and lost respect the window; open does not.
         *
         * Open Pipeline is what is in play RIGHT NOW. There is no such thing
         * as "the open pipeline of July" — those deals have since closed or
         * are still open today — so it is deliberately unfiltered, and the
         * screen says so rather than implying the window applies to it.
         */
        `SELECT
           COALESCE(SUM(value_cents) FILTER (WHERE won_at IS NOT NULL${won.sql}), 0)::text AS won_cents,
           count(*) FILTER (WHERE won_at IS NOT NULL${won.sql})::text                      AS won_count,
           COALESCE(SUM(value_cents) FILTER (WHERE stage = ANY($2)), 0)::text              AS open_cents,
           count(*) FILTER (WHERE stage = ANY($2))::text                                   AS open_count,
           count(*) FILTER (WHERE stage = 'lost')::text                                    AS lost_count
         FROM deals
         WHERE sub_account_id = $1 AND deleted_at IS NULL`,
        [tenant, [...OPEN_STAGES], ...won.params]
  );

  const stages = await q.rows<{ stage: Stage; count: string; value_cents: string }>(
        `SELECT stage, count(*)::text AS count, COALESCE(SUM(value_cents), 0)::text AS value_cents
         FROM deals
         WHERE sub_account_id = $1 AND deleted_at IS NULL
         GROUP BY stage`,
        [tenant]
  );

  const sources = await q.rows<{ source: Source; deals: string; won_deals: string; won_cents: string }>(
        // Revenue by source is a period question: "where did July's money come
        // from". The deal COUNT stays all-time, because a source's total
        // history is what makes its conversion rate meaningful.
        `SELECT source,
                count(*)::text AS deals,
                count(*) FILTER (WHERE won_at IS NOT NULL${wonWithin(window, 2).sql})::text AS won_deals,
                COALESCE(SUM(value_cents) FILTER (WHERE won_at IS NOT NULL${wonWithin(window, 2).sql}), 0)::text AS won_cents
         FROM deals
         WHERE sub_account_id = $1 AND deleted_at IS NULL
         GROUP BY source`,
        [tenant, ...wonWithin(window, 2).params]
  );

  const losses = await q.rows<{ reason: string; count: string }>(
        `SELECT lost_reason AS reason, count(*)::text AS count
         FROM deals
         WHERE sub_account_id = $1 AND deleted_at IS NULL
           AND stage = 'lost' AND lost_reason IS NOT NULL
         GROUP BY lost_reason
         ORDER BY count(*) DESC, lost_reason`,
        [tenant]
  );

  // Grouped by the database's week, so the buckets do not shift with
      // whichever server rendered the page.
  const weekly = await q.rows<{ week_start: Date; won_cents: string }>(
        `SELECT date_trunc('week', won_at) AS week_start,
                COALESCE(SUM(value_cents), 0)::text AS won_cents
         FROM deals
         WHERE sub_account_id = $1 AND deleted_at IS NULL AND won_at IS NOT NULL
           AND won_at >= date_trunc('week', now()) - interval '7 weeks'
         GROUP BY 1
         ORDER BY 1 ASC`,
        [tenant]
  );

  const contacts = await q.one<{ total: string; clients: string; leads: string }>(
        // Lead and client are derived from deals, exactly as the contacts repo
        // derives them, rather than read from a stored status that goes stale.
        `SELECT
           count(*)::text AS total,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM deals d
             WHERE d.contact_id = c.id AND d.deleted_at IS NULL AND d.won_at IS NOT NULL
           ))::text AS clients,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM deals d
             WHERE d.contact_id = c.id AND d.deleted_at IS NULL AND d.stage = ANY($2)
           ))::text AS leads
         FROM contacts c
         WHERE c.sub_account_id = $1 AND c.deleted_at IS NULL`,
        [tenant, [...OPEN_STAGES]]
  );

  const owners = await q.rows<{ owner_user_id: string; name: string; won_count: string; won_cents: string }>(
        `SELECT d.owner_user_id,
                COALESCE(u.name, 'Unassigned') AS name,
                count(*)::text AS won_count,
                COALESCE(SUM(d.value_cents), 0)::text AS won_cents
         FROM deals d
         LEFT JOIN users u ON u.id = d.owner_user_id
         WHERE d.sub_account_id = $1 AND d.deleted_at IS NULL AND d.won_at IS NOT NULL
         GROUP BY d.owner_user_id, u.name
         ORDER BY SUM(d.value_cents) DESC`,
        [tenant]
  );

  const voice = await q.one<{ calls: string; produced: string; seconds: string }>(
        `SELECT count(*)::text AS calls,
                count(*) FILTER (WHERE created_deal_id IS NOT NULL)::text AS produced,
                COALESCE(SUM(duration_sec), 0)::text AS seconds
         FROM calls
         WHERE sub_account_id = $1 AND deleted_at IS NULL`,
        [tenant]
  );

  const meetings = await meetingStats(q);

  const wonCount = n(totals?.won_count);
  const lostCount = n(totals?.lost_count);
  const decided = wonCount + lostCount;
  const callCount = n(voice?.calls);
  const callSeconds = n(voice?.seconds);

  const stageByName = new Map(stages.map((r) => [r.stage, r]));
  const sourceByName = new Map(sources.map((r) => [r.source, r]));

  return {
    revenue: {
      wonCents: n(totals?.won_cents),
      wonCount,
      openPipelineCents: n(totals?.open_cents),
      openCount: n(totals?.open_count),
      // An average of nothing is not zero, and a £0 average deal on a new
      // account reads as a real and alarming figure.
      avgWonDealCents: wonCount > 0 ? Math.round(n(totals?.won_cents) / wonCount) : null,
    },

    /**
     * A PERCENTAGE, 0–100 — not a ratio.
     *
     * This returned `wonCount / decided` while every formatter printed
     * `${v}%`, so a perfect record rendered as "1%" and a two-in-three record
     * as "0.67%". Three different producers returned ratios, one returned a
     * percentage, and a single formatter appended the sign to all of them.
     * Every rate in the product now means the same thing.
     */
    winRate: decided > 0 ? Math.round((wonCount / decided) * 100) : null,

    // Every stage appears, including the empty ones: a pipeline chart that
    // silently drops a stage with no deals in it makes the funnel look shorter
    // than it is, and hides exactly the gap worth noticing.
    byStage: STAGES.map((stage) => ({
      stage,
      count: n(stageByName.get(stage)?.count),
      valueCents: n(stageByName.get(stage)?.value_cents),
    })),

    bySource: SOURCES.map((source) => ({
      source,
      deals: n(sourceByName.get(source)?.deals),
      wonDeals: n(sourceByName.get(source)?.won_deals),
      wonCents: n(sourceByName.get(source)?.won_cents),
    })),

    lossReasons: losses.map((r) => ({ reason: r.reason, count: n(r.count) })),

    weekly: weekly.map((r) => ({
      weekStart: r.week_start.toISOString(),
      wonCents: n(r.won_cents),
    })),

    meetings,

    contacts: {
      total: n(contacts?.total),
      clients: n(contacts?.clients),
      leads: n(contacts?.leads),
    },

    // One owner is not a leaderboard; it is a picture of you. Shown only when
    // there is something to compare.
    owners:
      owners.length > 1
        ? owners.map((r) => ({
            ownerUserId: r.owner_user_id,
            name: r.name,
            wonCount: n(r.won_count),
            wonCents: n(r.won_cents),
          }))
        : [],

    voice: {
      calls: callCount,
      producedDeal: n(voice?.produced),
      totalSeconds: callSeconds,
      avgSeconds: callCount > 0 ? Math.round(callSeconds / callCount) : null,
    },
  };
}

/** Named for the page's sake, so a caller cannot mistake won-ness for a stage. */
export { WON_STAGES, OPEN_STAGES };
