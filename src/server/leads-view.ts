import type { LeadCard, LeadSource, LeadStatus } from "@/data/leads";
import type { AvatarColor } from "@/components/ui/Avatar";
import type { TenantQuery } from "./tenant";

/**
 * The Leads page, without a leads table.
 *
 * A lead was a separate record holding the same human as a contact, joined by
 * nothing. That record is gone. What survives is the *question* the page asks —
 * who is coming in, where from, and are we hitting target — which is worth
 * keeping, because it is not the question the Contacts page asks.
 *
 * So a lead here is what the schema already says it is: a contact with a deal
 * still in play. Everything on this page is read from that, which means it can
 * no longer disagree with the pipeline board the way two tables did.
 *
 * `status` is derived from the deal's stage rather than stored. The old model
 * stored it and had to keep re-deriving it from calls and meetings anyway,
 * because a stored sales position goes stale the moment anything happens.
 */

export type LeadAnalytics = {
  total: number;
  /** Nobody has done anything with these yet. */
  fresh: number;
  open: number;
  closed: number;
  /** Captured in the last 7 days. */
  newThisWeek: number;
  /** Kept for the card's shape; every deal carries a timestamp now. */
  newThisWeekUnknown: boolean;
  conversion: number | null;
  bySource: { label: LeadSource; count: number; pct: number }[];
};

const SOURCE_LABEL: Record<string, LeadSource> = {
  google_ads: "Google Ads",
  facebook: "Facebook",
  referral: "Referral",
  phone_call: "Phone Call",
};

const AVATAR_COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

function paletteFor(id: string): AvatarColor {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/**
 * Stage → the three statuses this page speaks in.
 *
 * `prospect` means nothing has happened yet; anything further along means work
 * is underway; a recorded win is a win. Derived on every read, so it cannot be
 * left saying "New Lead" about somebody who has since bought.
 */
function statusFor(stage: string, wonAt: string | null): LeadStatus {
  if (wonAt) return "Closed Won";
  return stage === "prospect" ? "New Lead" : "Follow-up Required";
}

type Row = {
  contact_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  info: string | null;
  stage: string;
  source: string;
  won_at: Date | null;
  created_at: Date;
};

/**
 * Everyone in the pipeline, with the status their deal implies.
 *
 * One row per person, taking their earliest live deal — somebody with two
 * opportunities is still one lead on this page, and counting them twice would
 * overstate both the feed and the source breakdown.
 */
export async function listLeadsWithStatus(q: TenantQuery): Promise<LeadCard[]> {
  const rows = await q.rows<Row>(
    `SELECT DISTINCT ON (c.id)
            c.id AS contact_id, c.first_name, c.last_name, c.email, c.phone,
            c.location, c.info, d.stage, d.source, d.won_at, d.created_at
     FROM contacts c
     JOIN deals d ON d.contact_id = c.id AND d.deleted_at IS NULL AND d.stage <> 'lost'
     WHERE c.sub_account_id = $1 AND c.deleted_at IS NULL
     ORDER BY c.id, d.created_at ASC`,
    [q.ctx.subAccountId]
  );

  return rows
    .map((r) => ({
      id: r.contact_id,
      initials: ((r.first_name[0] ?? "") + (r.last_name[0] ?? "")).toUpperCase() || "—",
      color: paletteFor(r.contact_id),
      name: `${r.first_name} ${r.last_name}`.trim(),
      email: r.email ?? "",
      phone: r.phone ?? "",
      location: r.location ?? "",
      company: r.info ?? "",
      status: statusFor(r.stage, r.won_at ? r.won_at.toISOString() : null),
      // A source the page has no label for is shown as a referral only if it
      // really is one; anything else falls to the closest honest bucket rather
      // than being invented.
      source: SOURCE_LABEL[r.source] ?? "Referral",
      createdAt: r.created_at.toISOString(),
    }))
    .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
}

export async function leadAnalytics(q: TenantQuery): Promise<LeadAnalytics> {
  const leads = await listLeadsWithStatus(q);

  const total = leads.length;
  const fresh = leads.filter((l) => l.status === "New Lead").length;
  const open = leads.filter((l) => l.status === "Follow-up Required").length;
  const closed = leads.filter((l) => l.status === "Closed Won").length;

  const weekAgo = Date.now() - 7 * 86_400_000;
  const newThisWeek = leads.filter((l) => Date.parse(l.createdAt ?? "") >= weekAgo).length;

  const counts = new Map<LeadSource, number>();
  for (const l of leads) counts.set(l.source, (counts.get(l.source) ?? 0) + 1);

  return {
    total,
    fresh,
    open,
    closed,
    newThisWeek,
    // Every deal carries a created_at, so the question is always answerable
    // now. The flag stays because the card still reads it.
    newThisWeekUnknown: false,
    // Null rather than zero on an empty account: 0% reads as a verdict on
    // performance rather than an absence of data.
    conversion: total > 0 ? Math.round((closed / total) * 100) : null,
    bySource: [...counts.entries()]
      .map(([label, count]) => ({
        label,
        count,
        pct: total > 0 ? Math.round((count / total) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count),
  };
}
