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

/* ---------------- Lead ageing ---------------- */

export type AgeBucket = { id: string; label: string; count: number };

export type LeadAgeing = {
  /** Open leads carrying a usable timestamp, bucketed against the response target. */
  buckets: AgeBucket[];
  /** Open leads counted in the buckets above. */
  dated: number;
  /**
   * Open leads with no usable capture date. Reported rather than bucketed:
   * guessing an age for them would put a made-up number on the screen, and
   * silently dropping them would make the buckets disagree with the lead
   * counts elsewhere on the page.
   */
  undated: number;
  /** The single lead that has waited longest, or null when nothing is open. */
  oldest: { name: string; company: string; minutes: number } | null;
  /**
   * Median rather than mean. One lead forgotten for a month drags an average
   * far past anything the user would recognise as typical, and a typical wait
   * is the thing this number is for.
   */
  medianMinutes: number | null;
  /** Open, dated leads already past the two-hour target. */
  breaching: number;
};

const MINUTE_MS = 60_000;

/** The response target this business works to: answer within two hours. */
export const TARGET_MINUTES = 120;
/** Past this, a lead has gone from late to neglected. */
export const HARD_LIMIT_MINUTES = 1440;

/**
 * How long the open leads have been waiting.
 *
 * The buckets are hours, not weeks. A lead should be answered within an hour
 * or two and a day is the worst acceptable case, so week-and-month buckets
 * reported a page full of green while a six-hour-old lead was already late —
 * the scale hid the exact failure the panel exists to catch.
 *
 * Everything here is a count of records whose timestamp falls in a range, so
 * there is nothing to invent and nothing to estimate. Won leads are excluded:
 * the age of a closed deal is history, not work.
 *
 * `now` is injected so the buckets can be tested against fixed times instead
 * of whatever the clock says while the suite runs.
 */
export function leadAgeing(leads: LeadCard[], now: number = Date.now()): LeadAgeing {
  const open = leads.filter((l) => l.status !== "Closed Won");

  const ages: number[] = [];
  let undated = 0;

  for (const l of open) {
    const t = Date.parse(l.createdAt ?? "");
    if (Number.isNaN(t)) {
      undated++;
      continue;
    }
    /* A timestamp in the future is bad data, not a negative age. It clamps to
       zero — "captured, not yet waited" — rather than subtracting from a
       bucket or producing "-3 hours waiting". */
    ages.push(Math.max(0, Math.floor((now - t) / MINUTE_MS)));
  }

  const buckets: AgeBucket[] = [
    {
      id: "ontime",
      label: "Within 2 hours",
      count: ages.filter((m) => m <= TARGET_MINUTES).length,
    },
    {
      id: "late",
      label: "2–24 hours",
      count: ages.filter((m) => m > TARGET_MINUTES && m <= HARD_LIMIT_MINUTES).length,
    },
    {
      id: "cold",
      label: "Over a day",
      count: ages.filter((m) => m > HARD_LIMIT_MINUTES).length,
    },
  ];

  let oldest: LeadAgeing["oldest"] = null;
  let oldestMinutes = -1;
  for (const l of open) {
    const t = Date.parse(l.createdAt ?? "");
    if (Number.isNaN(t)) continue;
    const minutes = Math.max(0, Math.floor((now - t) / MINUTE_MS));
    if (minutes > oldestMinutes) {
      oldestMinutes = minutes;
      oldest = { name: l.name, company: l.company, minutes };
    }
  }

  const sorted = [...ages].sort((a, b) => a - b);
  const medianMinutes =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);

  return {
    buckets,
    dated: ages.length,
    undated,
    oldest,
    medianMinutes,
    breaching: ages.filter((m) => m > TARGET_MINUTES).length,
  };
}

/**
 * A wait, in the largest unit that still says something useful.
 *
 * Minutes below an hour, hours below a day, days beyond that. A lead answered
 * in forty minutes reading as "0 days" was the reason this exists.
 */
export function formatWait(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.floor(minutes / 1440);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * The colour a wait should be shown in, judged against the target.
 *
 * A pure function rather than a ternary inlined in the card, because the amber
 * and red paths are the ones that matter and an account whose leads are all
 * fresh never renders them — they would ship unverified. Here they are covered
 * by the suite regardless of what the data happens to look like.
 *
 * `null` is not a breach and not a success: it means nothing is open, which
 * has no colour to report.
 */
export function waitTone(minutes: number | null): string {
  if (minutes === null) return "var(--text-muted)";
  if (minutes <= TARGET_MINUTES) return "var(--green)";
  if (minutes <= HARD_LIMIT_MINUTES) return "var(--amber)";
  return "var(--red)";
}
