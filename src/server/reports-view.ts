import { reportData } from "./analytics";
import { meetingAnalytics, type MeetingAnalytics } from "./meeting-analytics";
import { stageMeta } from "@/data/pipeline";
import { changeAgainst, type Period } from "./report-period";
import type { AvatarColor } from "@/components/ui/Avatar";
import type { TenantQuery } from "./tenant";

/**
 * The Reports page's data, assembled for the screen.
 *
 * `analytics.ts` answers what happened; this decides how the page says it —
 * labels, colours, orderings. Keeping them apart is why the analytics layer can
 * be tested without knowing what a chart looks like.
 *
 * The `attribution` block is gone and is not replaced. It existed because won
 * deals were matched to leads BY NAME to discover their source — 4 of 10
 * matched — so the report had to carry an `unattributed` bucket admitting how
 * much money it could not explain. Source is a column on the deal now. Every
 * won deal has one, so there is nothing left to be unattributed.
 *
 * Money is in whole units here, because every figure on this page is rendered
 * with a currency symbol. Converted once, at this boundary.
 */

const toUnits = (cents: number) => Math.round(cents / 100);

const SOURCE_LABEL: Record<string, string> = {
  google_ads: "Google Ads",
  facebook: "Facebook",
  referral: "Referral",
  phone_call: "Phone Call",
  website: "Website",
  outbound: "Outbound",
  other: "Other",
};

const SOURCE_COLOR: Record<string, string> = {
  google_ads: "var(--accent)",
  facebook: "#1877F2",
  referral: "var(--purple)",
  phone_call: "var(--green)",
  website: "var(--amber)",
  outbound: "#f97316",
  other: "var(--border-strong)",
};

export type ReportView = {
  /** The window these figures cover, and how it compares. Null for all time. */
  period: {
    id: string;
    label: string;
    previousLabel: string | null;
    revenueChange: number | null;
    wonCountChange: number | null;
    previousRevenue: number | null;
  } | null;
  revenueWon: number;
  wonCount: number;
  openPipeline: number;
  openCount: number;
  winRate: number | null;
  avgDealSize: number | null;
  outstanding: number;
  weekly: { label: string; value: number }[];
  stages: { id: string; label: string; color: string; count: number; value: number }[];
  sources: { source: string; leads: number; revenue: number; color: string }[];
  leadStatus: { label: string; count: number; color: string }[];
  leadConversion: number | null;
  followUps: {
    id: string;
    name: string;
    company: string;
    source: string;
    initials: string;
    color: AvatarColor;
  }[];
  meetings: MeetingAnalytics;
  awaiting: { past: number; upcoming: number };
  topDeals: { id: string; title: string; contact: string; value: number; stage: string }[];
  owners: { owner: string; won: number; revenue: number }[];
  contacts: { clients: number; leads: number };
  voice: {
    calls: number;
    producedLead: number;
    bookedMeeting: number;
    byOutcome: { label: string; count: number; color: string }[];
    totalMinutes: number;
    avgSeconds: number | null;
  };
};

export async function reportView(q: TenantQuery, period?: Period): Promise<ReportView> {
  const window = { from: period?.from ?? null, to: period?.to ?? null };
  const r = await reportData(q, window);

  /**
   * The same figures over the window immediately before.
   *
   * A number on its own says almost nothing: £12,000 is a good month or a bad
   * one depending entirely on what last month was. Read as a second query
   * rather than derived, because "revenue in June" is not something that can be
   * calculated from "revenue in July".
   *
   * Skipped for all-time, which has no previous — see `resolvePeriod`.
   */
  const before = period?.previous
    ? await reportData(q, { from: period.previous.from, to: period.previous.to })
    : null;
  const meetings = await meetingAnalytics(q);
  const tenant = q.ctx.subAccountId;

  /**
   * Money on won deals that is still owed.
   *
   * A part-paid job leaves an open record holding the balance, sharing a split
   * id with the won half. This is the sum of those balances — real outstanding
   * invoices, not a forecast.
   */
  const outstandingRow = await q.one<{ total: string }>(
    `SELECT COALESCE(SUM(value_cents), 0)::text AS total
     FROM deals
     WHERE sub_account_id = $1 AND deleted_at IS NULL
       AND split_id IS NOT NULL AND won_at IS NULL`,
    [tenant]
  );

  const topDeals = await q.rows<{
    id: string;
    title: string;
    value_cents: string;
    stage: string;
    contact_name: string | null;
  }>(
    `SELECT d.id, d.title, d.value_cents, d.stage,
            NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), '') AS contact_name
     FROM deals d
     LEFT JOIN contacts c ON c.id = d.contact_id
     WHERE d.sub_account_id = $1 AND d.deleted_at IS NULL AND d.stage <> 'lost'
     ORDER BY d.value_cents DESC LIMIT 5`,
    [tenant]
  );

  /**
   * People waiting on a next step.
   *
   * A status breakdown says four are overdue; it does not say who. The panel
   * has room for the answer, so it gives it. "Waiting" means an open deal —
   * the definition of a lead now — and the source comes from that deal.
   */
  const followUps = await q.rows<{
    id: string;
    first_name: string;
    last_name: string;
    info: string | null;
    source: string | null;
  }>(
    `SELECT c.id, c.first_name, c.last_name, c.info,
            (SELECT d.source FROM deals d
             WHERE d.contact_id = c.id AND d.deleted_at IS NULL
               AND d.stage IN ('prospect','discovery','demo')
             ORDER BY d.created_at ASC LIMIT 1) AS source
     FROM contacts c
     WHERE c.sub_account_id = $1 AND c.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM deals d
         WHERE d.contact_id = c.id AND d.deleted_at IS NULL
           AND d.stage IN ('prospect','discovery','demo')
       )
     ORDER BY c.created_at DESC LIMIT 6`,
    [tenant]
  );

  /**
   * The awaiting-outcome backlog, split by whether the meeting has happened.
   *
   * "10 awaiting" on its own overstates it: a meeting next week simply has not
   * occurred yet, while one from last week is genuinely waiting on the user.
   * Only `past` is a backlog anybody can act on.
   */
  const awaitingRow = await q.one<{ past: string; upcoming: string }>(
    `SELECT count(*) FILTER (WHERE scheduled_at < now())::text  AS past,
            count(*) FILTER (WHERE scheduled_at >= now())::text AS upcoming
     FROM meetings
     WHERE sub_account_id = $1 AND deleted_at IS NULL AND outcome = 'scheduled'`,
    [tenant]
  );

  const voiceOutcomes = await q.rows<{ outcome: string | null; count: string }>(
    `SELECT outcome, count(*)::text AS count
     FROM calls
     WHERE sub_account_id = $1 AND deleted_at IS NULL
     GROUP BY outcome ORDER BY count(*) DESC`,
    [tenant]
  );

  const bookedRow = await q.one<{ n: string }>(
    // A call "booked a meeting" only if a meeting actually points at the same
    // contact and was created after the call. Counting intent would be a guess.
    `SELECT count(DISTINCT c.id)::text AS n
     FROM calls c
     JOIN meetings m ON m.contact_id = c.contact_id AND m.created_at >= c.received_at
     WHERE c.sub_account_id = $1 AND c.deleted_at IS NULL AND m.deleted_at IS NULL
       AND c.contact_id IS NOT NULL`,
    [tenant]
  );

  const n = (v: string | undefined) => Number(v ?? 0);
  const totalPeople = r.contacts.total;

  return {
    period: period
      ? {
          id: period.id,
          label: period.label,
          previousLabel: period.previousLabel,
          // Compared on the same measures the tiles show, so the arrow and the
          // number can never disagree about which way things went.
          revenueChange: before ? changeAgainst(r.revenue.wonCents, before.revenue.wonCents) : null,
          wonCountChange: before ? changeAgainst(r.revenue.wonCount, before.revenue.wonCount) : null,
          previousRevenue: before ? toUnits(before.revenue.wonCents) : null,
        }
      : null,
    revenueWon: toUnits(r.revenue.wonCents),
    wonCount: r.revenue.wonCount,
    openPipeline: toUnits(r.revenue.openPipelineCents),
    openCount: r.revenue.openCount,
    winRate: r.winRate,
    avgDealSize: r.revenue.avgWonDealCents === null ? null : toUnits(r.revenue.avgWonDealCents),
    outstanding: toUnits(n(outstandingRow?.total)),

    weekly: r.weekly.map((w) => ({
      label: new Date(w.weekStart).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      value: toUnits(w.wonCents),
    })),

    stages: r.byStage.map((s) => {
      const meta = stageMeta(s.stage);
      return {
        id: s.stage,
        label: meta.label,
        color: meta.color,
        count: s.count,
        value: toUnits(s.valueCents),
      };
    }),

    sources: r.bySource
      // A source with nothing at all behind it is noise on a chart, though the
      // analytics layer keeps it so the absence is still countable.
      .filter((s) => s.deals > 0)
      .map((s) => ({
        source: SOURCE_LABEL[s.source] ?? s.source,
        leads: s.deals,
        revenue: toUnits(s.wonCents),
        color: SOURCE_COLOR[s.source] ?? "var(--border-strong)",
      })),

    leadStatus: [
      { label: "Clients", count: r.contacts.clients, color: "var(--green)" },
      { label: "In progress", count: r.contacts.leads, color: "var(--accent)" },
      {
        // Everybody else: people on file with no deal either way. Shown rather
        // than hidden, because a contact list full of them is the finding.
        label: "No open deal",
        count: Math.max(0, totalPeople - r.contacts.clients - r.contacts.leads),
        color: "var(--border-strong)",
      },
    ].filter((s) => s.count > 0),

    // Null rather than zero with nobody on file: a 0% conversion on an empty
    // account is a number that looks like a verdict.
    // Percentage, 0–100 — the unit every rate in the product uses.
    leadConversion: totalPeople > 0 ? Math.round((r.contacts.clients / totalPeople) * 100) : null,

    followUps: followUps.map((f) => ({
      id: f.id,
      name: `${f.first_name} ${f.last_name}`.trim(),
      company: f.info ?? "",
      source: f.source ? (SOURCE_LABEL[f.source] ?? f.source) : "—",
      initials: ((f.first_name[0] ?? "") + (f.last_name[0] ?? "")).toUpperCase() || "—",
      color: "amber" as AvatarColor,
    })),

    meetings,
    awaiting: { past: n(awaitingRow?.past), upcoming: n(awaitingRow?.upcoming) },

    topDeals: topDeals.map((d) => ({
      id: d.id,
      title: d.title,
      contact: d.contact_name ?? "—",
      value: toUnits(Number(d.value_cents)),
      stage: stageMeta(d.stage as Parameters<typeof stageMeta>[0]).label,
    })),

    owners: r.owners.map((o) => ({
      owner: o.name,
      won: o.wonCount,
      revenue: toUnits(o.wonCents),
    })),

    contacts: { clients: r.contacts.clients, leads: r.contacts.leads },

    voice: {
      calls: r.voice.calls,
      producedLead: r.voice.producedDeal,
      bookedMeeting: n(bookedRow?.n),
      byOutcome: voiceOutcomes.map((o) => ({
        label: o.outcome ?? "Not recorded",
        count: Number(o.count),
        color: o.outcome ? "var(--accent)" : "var(--border-strong)",
      })),
      totalMinutes: Math.round(r.voice.totalSeconds / 60),
      avgSeconds: r.voice.avgSeconds,
    },
  };
}
