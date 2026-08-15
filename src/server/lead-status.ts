import { LEAD_SOURCES, type LeadCard, type LeadSource, type LeadStatus } from "@/data/leads";
import { listCalls } from "./calls-repo";
import { listDeals } from "./deals-repo";
import { listLeads as listRawLeads } from "./leads-repo";
import { listMeetings } from "./meetings-repo";

/**
 * A lead's status, worked out from what has actually happened to it.
 *
 * Status used to be typed in at creation and never moved again, so it recorded
 * an intention rather than reality — a lead could sit on "Follow-up Required"
 * long after the deal closed, and creating one forced a choice of outcome
 * before anything had happened at all.
 *
 * This lives outside `leads-repo` on purpose: `calls-repo` already imports that
 * module to create leads from calls, so reading calls from inside it would
 * close an import cycle. Same shape as `contact-timeline` — the repos stay
 * leaves, and the module that needs several of them sits above.
 */

/** Digits only, so "+27 82 123 4567" and "0821234567" compare equal. */
const digits = (s: string) => s.replace(/\D/g, "");
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function deriveStatus(
  lead: LeadCard,
  calls: Awaited<ReturnType<typeof listCalls>>,
  meetings: Awaited<ReturnType<typeof listMeetings>>,
  deals: Awaited<ReturnType<typeof listDeals>>
): LeadStatus {
  const phone = digits(lead.phone);
  const matchesPhone = (other: string) =>
    phone.length >= 7 && digits(other).endsWith(phone.slice(-9));

  const theirMeetings = meetings.filter((m) => sameName(m.name, lead.name));
  const theirCalls = calls.filter((c) => sameName(c.callerName, lead.name) || matchesPhone(c.phone));

  //   • a won deal, or a meeting that ended "won"  → Closed Won
  //   • otherwise a call taken or meeting booked   → Follow-up Required
  //   • nothing has happened yet                   → New Lead
  const wonDeal = deals.some((d) => d.stage === "won" && sameName(d.contact, lead.name));
  const wonMeeting = theirMeetings.some((m) => m.outcome === "won");

  if (wonDeal || wonMeeting) return "Closed Won";
  if (theirCalls.length > 0 || theirMeetings.length > 0) return "Follow-up Required";

  // No events at all — honour what was stored, mapping the old vocabulary
  // forward so rows written before this existed don't reset to "New Lead".
  const stored = lead.status as string;
  if (stored === "Closed" || stored === "Closed Won") return "Closed Won";
  if (stored === "Follow-up Required") return "Follow-up Required";
  return "New Lead";
}

/** Every lead, with its status brought up to date. */
export async function listLeadsWithStatus(): Promise<LeadCard[]> {
  const [rows, calls, meetings, deals] = await Promise.all([
    listRawLeads(),
    listCalls(),
    listMeetings(),
    listDeals(),
  ]);

  return rows.map((lead) => {
    const status = deriveStatus(lead, calls, meetings, deals);
    return status === lead.status ? lead : { ...lead, status };
  });
}

/* ---------------- analytics ---------------- */

export type LeadAnalytics = {
  total: number;
  /** Nothing has happened to these yet. */
  fresh: number;
  open: number;
  closed: number;
  /** Captured in the last 7 days. Only counts leads that carry a timestamp. */
  newThisWeek: number;
  /** True when no lead has a timestamp, so "this week" can't be answered. */
  newThisWeekUnknown: boolean;
  conversion: number | null;
  bySource: { label: LeadSource; count: number; pct: number }[];
};

export async function leadAnalytics(): Promise<LeadAnalytics> {
  const rows = await listLeadsWithStatus();
  const total = rows.length;

  const closed = rows.filter((l) => l.status === "Closed Won").length;
  const open = rows.filter((l) => l.status === "Follow-up Required").length;
  const fresh = rows.filter((l) => l.status === "New Lead").length;

  const weekAgo = Date.now() - 7 * 86_400_000;
  const dated = rows.filter((l) => l.createdAt && Number.isFinite(Date.parse(l.createdAt)));
  const newThisWeek = dated.filter((l) => Date.parse(l.createdAt!) >= weekAgo).length;

  const bySource = LEAD_SOURCES.map((label) => {
    const count = rows.filter((l) => l.source === label).length;
    return { label, count, pct: total > 0 ? Math.round((count / total) * 100) : 0 };
  }).filter((s) => s.count > 0);

  return {
    total,
    fresh,
    open,
    closed,
    newThisWeek,
    // Every lead predates the field — say "—" rather than report a false zero.
    newThisWeekUnknown: total > 0 && dated.length === 0,
    conversion: total > 0 ? Math.round((closed / total) * 100) : null,
    bySource,
  };
}
