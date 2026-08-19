import { LOSS_REASONS } from "@/data/meetings";
import type { TenantQuery } from "./tenant";

/**
 * The Meetings page's figures.
 *
 * The model is ported intact from the version the audit rated as correct, and
 * its two rules are the reason the numbers mean anything:
 *
 *  - An outcome is RECORDED, never inferred. A meeting in the past whose
 *    outcome nobody entered stays pending; it is not quietly counted as a
 *    no-show because time passed.
 *  - Every rate is out of DECIDED meetings. Counting pending ones as failures
 *    would make the show rate fall each time a meeting was booked, which is
 *    the arithmetic error the deal pipeline used to have.
 *
 * Rates are null, never zero, with nothing behind them. "No data" and "0%" are
 * different claims and only one of them is honest on a new account.
 */

export type MeetingAnalytics = {
  total: number;
  /** Outcome still unrecorded — the honest caveat on every rate below. */
  pending: number;
  /** The denominator: meetings whose outcome is known. */
  decided: number;
  showed: number;
  noShow: number;
  advanced: number;
  won: number;
  lost: number;
  showRate: number | null;
  conversion: number | null;
  lossRate: number | null;
  funnel: { label: string; value: number; pct: number }[];
  lossReasons: { label: string; count: number; pct: number }[];
  byType: { online: number; inPerson: number };
};

export async function meetingAnalytics(q: TenantQuery): Promise<MeetingAnalytics> {
  const row = await q.one<{
    total: string;
    pending: string;
    no_show: string;
    showed: string;
    advanced: string;
    won: string;
    lost: string;
    online: string;
    in_person: string;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE outcome = 'scheduled')::text AS pending,
            count(*) FILTER (WHERE outcome = 'no_show')::text   AS no_show,
            count(*) FILTER (WHERE outcome = 'showed')::text    AS showed,
            count(*) FILTER (WHERE outcome = 'advanced')::text  AS advanced,
            count(*) FILTER (WHERE outcome = 'won')::text       AS won,
            count(*) FILTER (WHERE outcome = 'lost')::text      AS lost,
            count(*) FILTER (WHERE kind = 'online')::text       AS online,
            count(*) FILTER (WHERE kind = 'in_person')::text    AS in_person
     FROM meetings
     WHERE sub_account_id = $1 AND deleted_at IS NULL`,
    [q.ctx.subAccountId]
  );

  const reasons = await q.rows<{ reason: string; count: string }>(
    `SELECT loss_reason AS reason, count(*)::text AS count
     FROM meetings
     WHERE sub_account_id = $1 AND deleted_at IS NULL
       AND outcome = 'lost' AND loss_reason IS NOT NULL
     GROUP BY loss_reason`,
    [q.ctx.subAccountId]
  );

  const n = (v: string | undefined) => Number(v ?? 0);
  const total = n(row?.total);
  const pending = n(row?.pending);
  const noShow = n(row?.no_show);
  const showed = n(row?.showed);
  const advanced = n(row?.advanced);
  const won = n(row?.won);
  const lost = n(row?.lost);
  const decided = total - pending;

  // Everything that happened, whatever came of it afterwards.
  const attended = showed + advanced + won + lost;
  const pct = (v: number, of: number) => (of > 0 ? Math.round((v / of) * 100) : 0);

  const byReason = new Map(reasons.map((r) => [r.reason, Number(r.count)]));
  const lossTotal = lost + noShow;

  return {
    total,
    pending,
    decided,
    showed,
    noShow,
    advanced,
    won,
    lost,
    showRate: decided > 0 ? attended / decided : null,
    // Out of decided meetings, not out of everything ever booked.
    conversion: decided > 0 ? won / decided : null,
    lossRate: decided > 0 ? lossTotal / decided : null,

    // The funnel is in process order: booked → showed → advanced → won. Each
    // step is a count of meetings that reached at least that far, so it can
    // only ever narrow — a funnel that widens is a bug in the arithmetic.
    funnel: [
      { label: "Booked", value: decided, pct: 100 },
      { label: "Showed up", value: attended, pct: pct(attended, decided) },
      { label: "Advanced", value: advanced + won, pct: pct(advanced + won, decided) },
      { label: "Closed won", value: won, pct: pct(won, decided) },
    ],

    // A no-show is a loss with a known cause, so it joins the breakdown rather
    // than sitting outside it and making the percentages fail to add up.
    lossReasons: [
      ...LOSS_REASONS.map((label) => ({
        label,
        count: (byReason.get(label) ?? 0) + (label === "No-show" ? noShow : 0),
      })),
    ]
      .filter((r) => r.count > 0)
      .map((r) => ({ ...r, pct: pct(r.count, lossTotal) }))
      .sort((a, b) => b.count - a.count),

    byType: { online: n(row?.online), inPerson: n(row?.in_person) },
  };
}
