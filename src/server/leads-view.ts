import type { LeadCard, LeadSource, LeadStatus } from "@/data/leads";
import type { AvatarColor } from "@/components/ui/Avatar";
import type { TenantQuery } from "./tenant";
import type { Source } from "./repos/deals";

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

/**
 * A deal's stored source, in the words this page speaks.
 *
 * `satisfies Record<Source, LeadSource>` is the point of it. This map used to
 * be `Record<string, LeadSource>`, which accepts any subset — so it covered
 * four of the seven sources a deal can carry and nothing complained. The three
 * it missed (website, outbound, other) hit the `?? "Referral"` below and were
 * counted as referrals: on a test account with two real referrals the panel
 * read "Referral 5 · 63%" and named it the top source.
 *
 * Typed against `Source`, an eighth source added to the deals repository fails
 * to compile until it is given a label here.
 */
export const SOURCE_LABEL = {
  google_ads: "Google Ads",
  facebook: "Facebook",
  referral: "Referral",
  phone_call: "Phone Call",
  website: "Website",
  outbound: "Outbound",
  other: "Other",
} satisfies Record<Source, LeadSource>;

/**
 * The same table read backwards, for the Add Lead form.
 *
 * Derived rather than written out again. The inverse used to be a second
 * hand-kept map in `leads/actions.ts`, and two hand-kept maps pointing opposite
 * ways is two things to forget instead of one.
 */
export const SOURCE_VALUE = Object.fromEntries(
  Object.entries(SOURCE_LABEL).map(([value, label]) => [label, value])
) as Record<LeadSource, Source>;

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
      /* The fallback is now "Other", and it is unreachable for any value the
         application writes — every one of those is in the table above, checked
         by the compiler. It catches only a row whose source predates a rename
         or was written straight to the database, and such a row is honestly
         unknown rather than quietly a referral. */
      source: SOURCE_LABEL[r.source as Source] ?? "Other",
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
  /** Open leads carrying a usable timestamp, on the four rungs below. */
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
  /** Open, dated leads that missed the one-hour target. */
  breaching: number;
};

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Call a new lead inside the hour. That is the whole incentive. */
export const TARGET_MINUTES = 60;
/** Past two days a lead is not late, it is neglected. */
export const STALE_MINUTES = 2880;

/**
 * The calendar date a timestamp falls on, in the business's own time zone.
 *
 * "Yesterday" has to mean yesterday where the business is, not in UTC — a lead
 * captured at 21:00 in Johannesburg is yesterday's work to the person opening
 * this page, and UTC would still be calling it today. `en-CA` is used only
 * because it formats as YYYY-MM-DD, which sorts and compares as a string.
 */
function dayKey(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

/** The calendar day before `key`, done as date arithmetic so DST cannot shift it. */
function previousDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - DAY_MS).toISOString().slice(0, 10);
}

/**
 * How long the open leads have been waiting, on the ladder the business works.
 *
 * Four rungs, evaluated IN ORDER, so every open lead lands on exactly one and
 * the counts always sum to `dated`:
 *
 *   1. Within the hour — the target, and the only rung that is good news.
 *   2. Earlier today   — slipped past the hour, still saveable today.
 *   3. Yesterday       — missed, and the first thing to work this morning.
 *   4. Still waiting   — older than yesterday. Yesterday's lead lands here
 *                        tomorrow if nobody calls it, which is the point.
 *
 * Order matters and is not cosmetic. A lead captured at 23:40 last night is an
 * hour old at 00:40 — by the calendar it is "yesterday", but the person has
 * done nothing wrong and the panel must not say they have. The hour rung is
 * tested first, so recency always beats the calendar.
 *
 * Rungs 2–4 are calendar days rather than elapsed hours because that is how
 * the work is actually organised: "the ones I didn't get to yesterday" is a
 * pile someone can pick up, whereas "the ones between 19 and 43 hours old" is
 * not. `timeZone` is the business's own, so the piles break where their day
 * breaks.
 *
 * Everything here is a count of records whose timestamp falls in a range —
 * nothing estimated, nothing derived from anything but `created_at`. Won leads
 * are excluded: the age of a closed deal is history, not work.
 *
 * `timeZone` and `now` are injected so the ladder can be tested against fixed
 * instants instead of whatever the clock and the server locale happen to say.
 * `now` is last and defaulted: reading the clock AT the call site is an impure
 * call during render, which the React compiler rejects outright.
 */
export function leadAgeing(
  leads: LeadCard[],
  timeZone: string = "UTC",
  now: number = Date.now()
): LeadAgeing {
  const open = leads.filter((l) => l.status !== "Closed Won");

  const today = dayKey(now, timeZone);
  const yesterday = previousDay(today);

  const counts = { hour: 0, today: 0, yesterday: 0, waiting: 0 };
  const ages: number[] = [];
  let undated = 0;
  let oldest: LeadAgeing["oldest"] = null;
  let oldestMinutes = -1;

  for (const l of open) {
    const t = Date.parse(l.createdAt ?? "");
    if (Number.isNaN(t)) {
      undated++;
      continue;
    }

    /* A timestamp in the future is bad data, not a negative age. It clamps to
       zero — "captured, not yet waited" — rather than producing "-3 hours" or
       landing on a rung by being ahead of the clock. */
    const minutes = Math.max(0, Math.floor((now - t) / MINUTE_MS));
    ages.push(minutes);

    if (minutes > oldestMinutes) {
      oldestMinutes = minutes;
      oldest = { name: l.name, company: l.company, minutes };
    }

    if (minutes < TARGET_MINUTES) counts.hour++;
    else {
      const key = dayKey(t, timeZone);
      /* `>=` rather than `===`, and the difference is currently unobservable:
         a future-dated lead clamps to zero minutes above and is caught by the
         hour rung, so `key > today` cannot be reached from here. Mutating it
         to `===` passes the whole suite for exactly that reason — an
         equivalent mutant, not a gap in the tests.

         It stays as `>=` because the two forms fail differently if the clamp
         ever moves: `>=` files a stray future date under today, which is
         harmless, while `===` would drop it onto "Still waiting" and accuse
         somebody over a row that has not aged at all. */
      if (key >= today) counts.today++;
      else if (key === yesterday) counts.yesterday++;
      else counts.waiting++;
    }
  }

  const buckets: AgeBucket[] = [
    { id: "hour", label: "Within the hour", count: counts.hour },
    { id: "today", label: "Earlier today", count: counts.today },
    { id: "yesterday", label: "Yesterday", count: counts.yesterday },
    { id: "waiting", label: "Still waiting", count: counts.waiting },
  ];

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
    breaching: ages.filter((m) => m >= TARGET_MINUTES).length,
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
  if (minutes < TARGET_MINUTES) return "var(--green)";
  if (minutes < 1440) return "var(--amber)";
  if (minutes < STALE_MINUTES) return "var(--red)";
  return "var(--red-deep)";
}
