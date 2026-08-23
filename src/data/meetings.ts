import type { AvatarColor } from "@/components/ui/Avatar";

/** Allowed values first, types derived — see the note in `data/contacts.ts`. */
export const MEETING_TYPES = ["Online", "In-Person"] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

export const MEETING_STATUSES = ["Confirmed", "Pending"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_WHENS = ["Today", "Tomorrow", "This Week"] as const;
export type MeetingWhen = (typeof MEETING_WHENS)[number];

/**
 * What actually happened at a meeting. This is what makes the funnel, the show
 * rate and the loss breakdown real numbers instead of decoration — every one of
 * them is counted from these values, so a meeting nobody has marked up simply
 * stays "scheduled" and is reported as pending rather than guessed at.
 *
 * The order is the funnel order: booked → showed → advanced → won.
 */
export const MEETING_OUTCOMES = ["scheduled", "no-show", "showed", "advanced", "won", "lost"] as const;
export type MeetingOutcome = (typeof MEETING_OUTCOMES)[number];

export const OUTCOME_LABELS: Record<MeetingOutcome, string> = {
  scheduled: "Scheduled",
  "no-show": "No-show",
  showed: "Showed up",
  advanced: "Advanced",
  won: "Closed won",
  lost: "Lost",
};

/** Why an opportunity was lost. Drives the Loss Insights panel. */
export const LOSS_REASONS = [
  "No-show",
  "Couldn't afford",
  "Not decision maker",
  "Not interested",
  "Competitor chosen",
  "Unqualified lead",
  "No follow-up",
  "Other",
] as const;
export type LossReason = (typeof LOSS_REASONS)[number];

export type UpcomingMeeting = {
  id: string;
  /**
   * The actual calendar date, `YYYY-MM-DD`.
   *
   * `when` below is a *derived label*, recomputed from this on every read. It
   * used to be the only thing stored, which meant a meeting booked "Today"
   * still said "Today" a week later — there was no date behind it to correct
   * from. Absent on rows written before this field existed; those fall back to
   * their stored label.
   */
  date?: string;
  when: MeetingWhen;
  time: string;
  initials: string;
  color: AvatarColor;
  name: string;
  company: string;
  topic: string;
  type: MeetingType;
  status: MeetingStatus;
  /** What happened. Absent on rows created before outcomes existed — treated
   *  as "scheduled" on read, never guessed at. */
  outcome?: MeetingOutcome;
  /** Only meaningful when `outcome` is "lost". */
  lossReason?: LossReason;
  /**
   * Where an online meeting actually happens.
   *
   * Clicking a row opens this. Absent means there is nothing to open, and the
   * row says so rather than pretending to be a link.
   */
  link?: string;
  /** Where change notifications go. Absent means nobody can be told. */
  email?: string;
  /** Notes for this meeting, saved against it rather than floating loose. */
  notes?: string;
};

/**
 * Seed dates, derived from the label each fixture was written with.
 *
 * The seed stored only `when: "Today" | "Tomorrow" | "This Week"` — a rendered
 * label with no date behind it. That is the same defect the schema fix
 * addressed for *new* meetings, but the fixtures were never migrated, so five
 * of nine meetings had nothing to place on the calendar and simply never
 * appeared on it. `whenFor()` recomputes the label from this on every read, so
 * these stay correct as days pass instead of freezing.
 */


