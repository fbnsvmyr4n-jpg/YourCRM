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
function seedDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  // Local getters, not toISOString — that shifts the day across time zones.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const upcomingMeetings: UpcomingMeeting[] = [
  {
    id: "mtg-alex-carter",
    date: seedDate(0),
    when: "Today",
    time: "10:00 AM",
    initials: "AC",
    color: "teal",
    name: "Alex Carter",
    company: "Carter Co.",
    topic: "Website Development",
    type: "Online",
    status: "Confirmed",
  },
  {
    id: "mtg-jamie-wilson",
    date: seedDate(0),
    when: "Today",
    time: "2:30 PM",
    initials: "JW",
    color: "green",
    name: "Jamie Wilson",
    company: "Wilson & Co.",
    topic: "CRM Implementation",
    type: "In-Person",
    status: "Confirmed",
  },
  {
    id: "mtg-morgan-smith",
    date: seedDate(1),
    when: "Tomorrow",
    time: "11:00 AM",
    initials: "MS",
    color: "amber",
    name: "Morgan Smith",
    company: "Smith Solutions",
    topic: "Sales Automation",
    type: "Online",
    status: "Confirmed",
  },
  {
    id: "mtg-taylor-brown",
    date: seedDate(1),
    when: "Tomorrow",
    time: "3:00 PM",
    initials: "TB",
    color: "purple",
    name: "Taylor Brown",
    company: "Brown Enterprises",
    topic: "Proposal Discussion",
    type: "In-Person",
    status: "Pending",
  },
  {
    id: "mtg-jenny-lou",
    date: seedDate(3),
    when: "This Week",
    time: "9:30 AM",
    initials: "JL",
    color: "pink",
    name: "Jenny Lou",
    company: "Lou Media",
    topic: "Referral Intro",
    type: "Online",
    status: "Pending",
  },
];

export const timeSlots = [
  "9:00 AM",
  "9:30 AM",
  "10:00 AM",
  "10:30 AM",
  "11:00 AM",
  "11:30 AM",
  "12:00 PM",
  "12:30 PM",
];
