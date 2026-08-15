import { LEAD_SOURCES, LEAD_STATUSES, STATUS_TONE, type LeadSource } from "@/data/leads";
import type { AvatarColor } from "@/components/ui/Avatar";
import { CALL_OUTCOMES, OUTCOME_META } from "@/data/calls";
import { listCalls } from "./calls-repo";
import { STAGES, type Deal } from "@/data/deals";
import { listDeals, weeklyRevenue } from "./deals-repo";
import { listLeadsWithStatus } from "./lead-status";
import { listContacts } from "./contacts-repo";
import { meetingAnalytics, type MeetingAnalytics } from "./meetings-repo";

/**
 * Everything the Reports page shows, computed in one place.
 *
 * The page used to derive its own figures inline, which is how it ended up
 * reporting three of the four lead sources — see `bySource` below. Deriving
 * here keeps the page a view, and means these numbers can be checked without
 * rendering anything.
 *
 * The rule throughout: **only report what the records actually say.** Nothing
 * here estimates, forecasts or fills a gap. Where the data cannot answer a
 * question, the shape says so — a `null` rate, an `unattributed` bucket — and
 * the page renders that honestly rather than printing a confident zero.
 */

export type SourceRow = {
  source: LeadSource;
  leads: number;
  /** Won revenue traced to this source. See `attribution` for the caveat. */
  revenue: number;
  color: string;
};

export type StageRow = {
  id: string;
  label: string;
  color: string;
  count: number;
  value: number;
};

export type ReportData = {
  /** Won revenue, all time, from each deal's recorded `wonAt`. */
  revenueWon: number;
  wonCount: number;
  /** Everything not yet won. */
  openPipeline: number;
  openCount: number;
  /** Won as a share of all deals. `null` until there is a deal to divide by. */
  winRate: number | null;
  avgDealSize: number | null;
  /** Money on won deals that is recorded as still owed, from the split fields. */
  outstanding: number;
  weekly: { label: string; value: number }[];
  stages: StageRow[];
  sources: SourceRow[];
  attribution: {
    /** Won deals whose contact matched a lead, so their source is known. */
    matched: number;
    total: number;
    /** Won revenue that could not be traced to a lead source. */
    unattributed: number;
  };
  leadStatus: { label: string; count: number; color: string }[];
  /** Share of leads that reached Closed Won. `null` with no leads to divide by. */
  leadConversion: number | null;
  /**
   * Leads whose status says they are waiting on you.
   *
   * A status breakdown tells you four are overdue; it does not tell you who. The
   * panel had room for the answer, so it gives it.
   */
  followUps: { id: string; name: string; company: string; source: LeadSource; initials: string; color: AvatarColor }[];
  meetings: MeetingAnalytics;
  topDeals: Deal[];
  /** Only meaningful with more than one owner; empty otherwise. */
  owners: { owner: string; won: number; revenue: number }[];
  contacts: { clients: number; leads: number };
  /**
   * What the voice agent has actually done.
   *
   * The agent is one of this CRM's headline features and was absent from every
   * report. Each figure is a count of stored call records, not a rate: a call
   * "produced a lead" only if it carries a lead id.
   */
  voice: {
    calls: number;
    /** Calls that ended up attached to a lead record. */
    producedLead: number;
    /** Calls that ended up attached to a meeting. */
    bookedMeeting: number;
    byOutcome: { label: string; count: number; color: string }[];
    totalMinutes: number;
    avgSeconds: number | null;
  };
};

const SOURCE_COLOR: Record<LeadSource, string> = {
  "Google Ads": "var(--accent)",
  Facebook: "#1877F2",
  Referral: "var(--purple)",
  "Phone Call": "var(--green)",
};

export async function reportData(): Promise<ReportData> {
  const [deals, leads, contacts, meetings, weekly, calls] = await Promise.all([
    listDeals(),
    listLeadsWithStatus(),
    listContacts(),
    // Shared with the Meetings page rather than recomputed: two screens
    // disagreeing about "show rate" is worse than either being imprecise.
    meetingAnalytics(),
    weeklyRevenue(6),
    listCalls(),
  ]);

  const won = deals.filter((d) => d.stage === "won");
  const open = deals.filter((d) => d.stage !== "won");
  const revenueWon = won.reduce((sum, d) => sum + d.value, 0);

  /**
   * Money still owed on deals already marked won.
   *
   * A partial payment splits a deal: the won half carries `splitTotal`, the
   * original contract value. Anything above what was banked is outstanding.
   */
  const outstanding = won.reduce(
    (sum, d) => sum + Math.max(0, (d.splitTotal ?? d.value) - d.value),
    0
  );

  /**
   * Which source produced which revenue.
   *
   * Won deals name a contact, not a lead, so the link is made on name — the
   * same match the inbox and contact panels use. Plenty of won deals belong to
   * people who were never a lead record, so the unmatched revenue is reported
   * as `unattributed` rather than being spread across the sources or quietly
   * dropped, either of which would overstate whichever channel did match.
   */
  const sourceOfLead = new Map<string, LeadSource>();
  for (const l of leads) {
    if (l.name) sourceOfLead.set(l.name.trim().toLowerCase(), l.source);
  }

  const revenueBySource = new Map<LeadSource, number>();
  let matched = 0;
  let unattributed = 0;
  for (const d of won) {
    const src = sourceOfLead.get(d.contact.trim().toLowerCase());
    if (src) {
      matched += 1;
      revenueBySource.set(src, (revenueBySource.get(src) ?? 0) + d.value);
    } else {
      unattributed += d.value;
    }
  }

  // Driven by LEAD_SOURCES, so a new source cannot go missing from this report
  // the way "Phone Call" did while the list was written out by hand here.
  const sources: SourceRow[] = LEAD_SOURCES.map((source) => ({
    source,
    leads: leads.filter((l) => l.source === source).length,
    revenue: revenueBySource.get(source) ?? 0,
    color: SOURCE_COLOR[source],
  }));

  // Driven by LEAD_STATUSES and the shared STATUS_TONE, for the same reason the
  // sources are: a hand-written copy of this list had "Closed" where the real
  // value is "Closed Won", so that row silently lost its colour.
  const leadStatus = LEAD_STATUSES.map((label) => ({
    label,
    count: leads.filter((l) => l.status === label).length,
    color: STATUS_TONE[label].color,
  })).sort((a, b) => b.count - a.count);

  const ownerMap = new Map<string, { won: number; revenue: number }>();
  for (const d of won) {
    const key = d.owner || "Unassigned";
    const row = ownerMap.get(key) ?? { won: 0, revenue: 0 };
    row.won += 1;
    row.revenue += d.value;
    ownerMap.set(key, row);
  }
  // One owner is not a comparison, so the page is given nothing to draw.
  const owners =
    ownerMap.size > 1
      ? [...ownerMap.entries()]
          .map(([owner, v]) => ({ owner, ...v }))
          .sort((a, b) => b.revenue - a.revenue)
      : [];

  return {
    revenueWon,
    wonCount: won.length,
    openPipeline: open.reduce((sum, d) => sum + d.value, 0),
    openCount: open.length,
    winRate: deals.length ? Math.round((won.length / deals.length) * 100) : null,
    avgDealSize: deals.length
      ? Math.round(deals.reduce((sum, d) => sum + d.value, 0) / deals.length)
      : null,
    outstanding,
    weekly,
    stages: STAGES.map((s) => {
      const rows = deals.filter((d) => d.stage === s.id);
      return {
        id: s.id,
        label: s.label,
        color: s.color,
        count: rows.length,
        value: rows.reduce((sum, d) => sum + d.value, 0),
      };
    }),
    sources,
    attribution: { matched, total: won.length, unattributed },
    leadStatus,
    leadConversion: leads.length
      ? Math.round((leads.filter((l) => l.status === "Closed Won").length / leads.length) * 100)
      : null,
    followUps: leads
      .filter((l) => l.status === "Follow-up Required")
      .slice(0, 4)
      .map((l) => ({
        id: l.id,
        name: l.name,
        company: l.company,
        source: l.source,
        initials: l.initials,
        color: l.color,
      })),
    meetings,
    // Seven rather than five: it fills the column beside the stacked meeting
    // and voice panels, and shows most of a small pipeline rather than a third
    // of it. The card links to Deals for the rest.
    topDeals: [...deals].sort((a, b) => b.value - a.value).slice(0, 7),
    owners,
    contacts: {
      clients: contacts.filter((c) => c.type === "client").length,
      leads: contacts.filter((c) => c.type === "lead").length,
    },
    voice: {
      calls: calls.length,
      producedLead: calls.filter((c) => c.createdLeadId).length,
      bookedMeeting: calls.filter((c) => c.createdMeetingId).length,
      // Driven by CALL_OUTCOMES and the shared OUTCOME_META, so a new outcome
      // cannot go missing here the way "Phone Call" did from the lead sources.
      byOutcome: CALL_OUTCOMES.map((o) => ({
        label: OUTCOME_META[o].label,
        count: calls.filter((c) => c.outcome === o).length,
        color: OUTCOME_META[o].color,
      })).filter((o) => o.count > 0),
      totalMinutes: Math.round(calls.reduce((sum, c) => sum + (c.durationSec || 0), 0) / 60),
      avgSeconds: calls.length
        ? Math.round(calls.reduce((sum, c) => sum + (c.durationSec || 0), 0) / calls.length)
        : null,
    },
  };
}
