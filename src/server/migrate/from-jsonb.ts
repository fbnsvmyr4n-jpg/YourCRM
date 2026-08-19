import { wallClockToInstant } from "@/lib/zoned";

/**
 * Migration: `crm_collections` (JSONB documents) → the relational schema.
 *
 * Written as pure mapping functions plus one orchestrator, so every decision
 * below can be tested without a database and inspected without running it.
 *
 * Three properties this has to hold, in order of how badly they hurt:
 *
 *  1. **Nothing is silently dropped.** Every legacy field either lands in a
 *     column or is listed in `UNMAPPED` with a reason. A migration that quietly
 *     loses a field is discovered months later by the person who needed it.
 *  2. **It is reversible.** Everything is written inside one transaction, so a
 *     failure anywhere leaves the database exactly as it was. The old
 *     collections are not touched at all — the rollback is "stop reading the
 *     new tables", not "restore from a backup".
 *  3. **It is verifiable.** `verify()` re-counts the result independently and
 *     reports a discrepancy rather than trusting that the writes worked.
 *
 * The one genuinely hard part is that `leads` and `contacts` were separate
 * tables holding the same people, joined by nothing. Merging them is the point
 * of the exercise and is also where a mistake creates duplicates that are
 * painful to unpick later, so `matchContact` is deliberately conservative:
 * email first because it is an identifier, name only as a fallback, and never
 * a fuzzy match.
 */

export type LegacyContact = {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  company?: string;
  companyInfo?: string;
  info?: string;
  owner?: string;
  createdAt?: string;
};

export type LegacyLead = {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  company?: string;
  status?: string;
  source?: string;
  createdAt?: string;
};

export type LegacyDeal = {
  id: string;
  title?: string;
  contact?: string;
  company?: string;
  value?: number;
  stage?: string;
  owner?: string;
  wonAt?: string;
  splitId?: string;
  splitTotal?: number;
};

export type LegacyMeeting = {
  id: string;
  date?: string;
  time?: string;
  name?: string;
  company?: string;
  topic?: string;
  type?: string;
  outcome?: string;
  lossReason?: string;
  link?: string;
  email?: string;
  notes?: string;
};

export type LegacyUser = {
  id: string;
  name?: string;
  email?: string;
  passwordHash?: string;
  role?: string;
};

export type LegacyCall = {
  id: string;
  callerName?: string;
  phone?: string;
  company?: string;
  receivedAt?: string;
  durationSec?: number;
  outcome?: string;
  summary?: string;
  topic?: string;
  transcript?: { speaker?: string; text?: string }[];
  requestedWhen?: string;
  requestedTime?: string;
  createdLeadId?: string;
  createdMeetingId?: string;
};

export type LegacyActivity = {
  id: string;
  contactId?: string;
  kind?: string;
  title?: string;
  detail?: string;
  at?: string;
};

export type LegacyChat = {
  id: string;
  role?: string;
  text?: string;
  at?: string;
};

export type LegacyMessage = {
  id: string;
  subject?: string;
  body?: string[];
  unread?: boolean;
  direction?: string;
  trashed?: boolean;
  at?: string;
  category?: string;
  email?: string;
  name?: string;
};

/**
 * Legacy fields with nowhere to go, and why.
 *
 * Written down rather than left implicit: a reader six months from now should
 * be able to see that a field was considered and dropped on purpose, not
 * overlooked. Anything genuinely worth keeping got a column instead — which is
 * how `split_id` and `split_total_cents` came to exist.
 */
export const UNMAPPED: Record<string, string> = {
  "contacts.initials": "derived from the name at render time",
  "contacts.color": "presentation; the avatar palette is chosen by the UI",
  "contacts.status": "a stored sales position, which is exactly what went stale — now derived from deals",
  "contacts.type": "lead vs client is derived from deals",
  "leads.initials": "derived",
  "leads.color": "presentation",
  "leads.status": "becomes the stage of the deal created for this lead",
  "deals.initials": "derived",
  "deals.color": "presentation",
  "deals.closeDate": "an expected date nothing ever read; won_at records what actually happened",
  "meetings.when": "a derived label ('Today'), recomputed from the date on read",
  "meetings.status": "Confirmed/Pending duplicated the outcome model and disagreed with it",
  "meetings.initials": "derived",
  "meetings.color": "presentation",
  "messages.preview": "the first line of the body, recomputed on read",
  "messages.assigned": "a folder that was never assignable to anyone",
  "messages.attachments": "no attachment storage exists yet; see the note in the migration report",
  "messages.role": "a job title on a message, never displayed",
  "messages.language": "never read",
  "messages.timeZone": "kept on the contact instead, once contacts carry a location",
  "users.initials": "derived from the name",
  "calls.initials": "derived",
  "calls.color": "presentation",
  "calls.status": "derived from whether the call produced records, so it cannot disagree with them",
  "calls.leadLink": "derived the same way — created vs matched is a fact about the links",
  "calls.company": "the caller's company belongs on their contact record, not on each call",
  "calls.requestedWhen": "a relative label; resolved to a real instant at migration",
};

// --- Value mappings ---------------------------------------------------------

/**
 * Old pipeline → Bradley's six stages.
 *
 * `negotiation` has no equivalent and maps to `demo`: the documented process
 * goes Demo → Close with no separate negotiating step, so a deal that was
 * negotiating is one that has been presented to and is not yet closed. That is
 * a deliberate loss of a distinction the new process does not make, not an
 * oversight — recorded here so nobody has to guess later.
 */
export const STAGE_MAP: Record<string, string> = {
  lead: "prospect",
  qualified: "discovery",
  proposal: "demo",
  negotiation: "demo",
  won: "won",
};

/** Lead status → the stage of the deal that lead becomes. */
export const LEAD_STATUS_MAP: Record<string, string> = {
  "New Lead": "prospect",
  // Something has happened and there is still work to do, which is Discovery.
  "Follow-up Required": "discovery",
  "Closed Won": "won",
  /**
   * `"Closed"` is not one of the three documented statuses, and three real
   * leads in production carry it — it predates or bypassed the enum.
   *
   * Read as won, for two reasons. The sibling value is "Closed Won" and there
   * has never been a "Closed Lost", so "Closed" almost certainly meant the
   * same thing; and it is the lower-risk reading either way, because leads
   * carry no value, so treating one as won cannot invent revenue. The opposite
   * mistake — filing a finished lead as an open prospect — silently inflates
   * open pipeline and understates the client count.
   *
   * Flagged in the migration plan regardless: this is a guess about what
   * somebody meant, and it should be confirmed before the real run.
   */
  Closed: "won",
};

export const SOURCE_MAP: Record<string, string> = {
  "Google Ads": "google_ads",
  Facebook: "facebook",
  Referral: "referral",
  "Phone Call": "phone_call",
};

/** Meeting outcomes differed only in punctuation, which is how they drifted. */
export const OUTCOME_MAP: Record<string, string> = {
  scheduled: "scheduled",
  "no-show": "no_show",
  showed: "showed",
  advanced: "advanced",
  won: "won",
  lost: "lost",
};

/**
 * Legacy user roles → the three the schema allows.
 *
 * Every existing user is "Admin", which under a single-workspace model meant
 * "the person using this". Under a tenant it means something narrower, so the
 * first user becomes the agency owner and the rest become admins — nobody is
 * demoted below what they had, and exactly one person can do the things only
 * an owner should.
 */
export const USER_ROLE_MAP: Record<string, string> = {
  Admin: "admin",
  Owner: "owner",
  Member: "member",
  User: "member",
};

/** Legacy transcript speakers → the stored roles. */
export const SPEAKER_MAP: Record<string, string> = {
  Agent: "agent",
  Caller: "caller",
};

export const MEETING_KIND_MAP: Record<string, string> = {
  Online: "online",
  "In-person": "in_person",
};

/**
 * Whole currency units → integer cents.
 *
 * `Math.round` rather than truncation, and it must happen exactly once. A
 * legacy value of 2500.5 is already suspect — money should never have been
 * fractional — so it is rounded to the nearest cent rather than rejected,
 * because refusing to migrate a real record because of an old bug helps nobody.
 */
export function toCents(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

/** Splits "Ada Lovelace" into parts without inventing one that is not there. */
export function splitName(full: string | undefined): { first: string; last: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

const normEmail = (e?: string) => (e ?? "").trim().toLowerCase();
const normName = (n?: string) => (n ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export type ContactKey = { id: string; email: string; name: string };

/**
 * Find the contact a legacy lead is already recorded as.
 *
 * Conservative on purpose. Email is an identifier, so an exact match on it is
 * trusted. A name is not — two people share one often enough that a fuzzy match
 * would merge different humans, which is far worse than leaving a duplicate:
 * a duplicate is visible and fixable, a wrong merge destroys one person's
 * history into another's and nothing says it happened.
 *
 * Returns null when unsure, and the caller creates a new contact.
 */
export function matchContact(
  lead: { email?: string; name?: string },
  contacts: ContactKey[]
): string | null {
  const email = normEmail(lead.email);
  if (email) {
    const byEmail = contacts.filter((c) => c.email === email);
    if (byEmail.length === 1) return byEmail[0].id;
    // Two contacts with the same address is itself a duplicate; picking one
    // would be a guess, so leave it to a human.
    if (byEmail.length > 1) return null;
  }

  const name = normName(lead.name);
  if (!name) return null;
  const byName = contacts.filter((c) => c.name === name);
  // Only when it is unambiguous AND the emails do not actively disagree.
  if (byName.length === 1) {
    const candidate = byName[0];
    if (email && candidate.email && candidate.email !== email) return null;
    return candidate.id;
  }
  return null;
}

/**
 * Combine a legacy date and time into a real instant.
 *
 * The legacy store kept `"2026-03-01"` and `"2:00 pm"` with no time zone —
 * wall-clock strings meaning whatever the person who typed them meant. The
 * conversion lives in `lib/zoned` and is shared with the booking form, so the
 * migration and the running product cannot disagree about what "2 pm" was.
 */
export function toTimestamp(date?: string, time?: string, zone = "UTC"): string | null {
  if (!date) return null;
  return wallClockToInstant(date, time ?? "00:00", zone);
}

export type MigrationReport = {
  /** Rows written, per table. */
  written: Record<string, number>;
  /** Legacy rows read, per collection. */
  read: Record<string, number>;
  /** Leads matched to an existing contact rather than creating a duplicate. */
  leadsMerged: number;
  /** Things a human should look at. Never silently swallowed. */
  warnings: string[];
};

export function emptyReport(): MigrationReport {
  return { written: {}, read: {}, leadsMerged: 0, warnings: [] };
}
