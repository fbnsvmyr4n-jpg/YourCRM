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
    // Percentages, 0–100. See the note on `winRate` in analytics.ts.
    showRate: decided > 0 ? Math.round((attended / decided) * 100) : null,
    // Out of decided meetings, not out of everything ever booked.
    conversion: decided > 0 ? Math.round((won / decided) * 100) : null,
    /**
     * A percentage, like the two above it — which it was not.
     *
     * This returned the raw fraction while its two neighbours, under the same
     * comment declaring "Percentages, 0-100", multiplied by a hundred. The view
     * renders it as `{lossRate}% Loss Rate`, so a board with one loss out of two
     * decided meetings displayed "0.5% Loss Rate" directly above the sentence
     * "1 of 2 decided opportunities were lost". Fifty percent, shown as a half
     * of one percent — the difference between a business that is fine and one
     * that is losing half of what it decides.
     *
     * Rounding is not cosmetic here either: unrounded, one loss in three
     * rendered as "0.3333333333333333% Loss Rate".
     */
    lossRate: decided > 0 ? Math.round((lossTotal / decided) * 100) : null,

    // The funnel is in process order: booked → showed → advanced → won. Each
    // step is a count of meetings that reached at least that far, so it can
    // only ever narrow — a funnel that widens is a bug in the arithmetic.
    funnel: [
      { label: "Booked", value: decided, pct: 100 },
      { label: "Showed up", value: attended, pct: pct(attended, decided) },
      { label: "Advanced", value: advanced + won, pct: pct(advanced + won, decided) },
      { label: "Closed won", value: won, pct: pct(won, decided) },
    ],

    /**
     * A no-show is a loss with a known cause, so it joins the breakdown rather
     * than sitting outside it and making the percentages fail to add up.
     *
     * And every OTHER loss has to land somewhere too. This mapped over the
     * fixed `LOSS_REASONS` list and looked each one up, which silently dropped
     * any reason not on it: the meeting still counted in `lost`, and therefore
     * in `lossRate` and the funnel, but its row vanished. The breakdown then
     * accounted for fewer losses than the panel above it claimed — two losses,
     * one line, and no way to tell from the screen.
     *
     * The UI only ever writes reasons from the list, so this is a guard against
     * a legacy row or a direct write rather than a daily occurrence. It still
     * belongs here: the failure is silent and lands on a number, which is the
     * combination worth being paranoid about. Unrecognised reasons are folded
     * into "Other", which claims nothing about why.
     */
    lossReasons: (() => {
      const known = new Set<string>(LOSS_REASONS);
      let unrecognised = 0;
      for (const [reason, count] of byReason) {
        if (!known.has(reason)) unrecognised += count;
      }
      return [
        ...LOSS_REASONS.map((label) => ({
          label,
          count:
            (byReason.get(label) ?? 0) +
            (label === "No-show" ? noShow : 0) +
            (label === "Other" ? unrecognised : 0),
        })),
      ];
    })()
      .filter((r) => r.count > 0)
      .map((r) => ({ ...r, pct: pct(r.count, lossTotal) }))
      .sort((a, b) => b.count - a.count),

    byType: { online: n(row?.online), inPerson: n(row?.in_person) },
  };
}
