import type { AvatarColor } from "@/components/ui/Avatar";

export type MsgFolder = "unread" | "assigned" | "sent" | "received" | "trash";

/** Allowed values first, types derived — see the note in `data/contacts.ts`. */
export const MSG_CATEGORIES = [
  "Appointments",
  "Tasks",
  "Meeting Requests",
  "Follow-ups",
  "Enquiries",
] as const;
export type MsgCategory = (typeof MSG_CATEGORIES)[number];

export const ATTACHMENT_KINDS = ["pdf", "doc", "txt"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export type Attachment = {
  name: string;
  size: string;
  kind: AttachmentKind;
  /**
   * The document's text.
   *
   * Attachments used to be name-and-size only, so there was nothing behind the
   * card to open — clicking one could never do anything. When this is present
   * the file opens in the viewer and the assistant can summarise it; when it is
   * absent the card says so rather than pretending.
   */
  content?: string;
};

export type Message = {
  id: string;
  initials: string;
  color: AvatarColor;
  name: string;
  role: string;
  company: string;
  subject: string;
  preview: string;
  unread: boolean;
  assigned: boolean;
  direction: "sent" | "received";
  trashed: boolean;
  body: string[];
  attachments: Attachment[];
  email: string;
  phone: string;
  language: string;
  /**
   * ISO timestamp — the stored truth.
   *
   * Replaces `time: "10:31"`, `ago: "2m ago"`, `localTime`, `firstInteraction`
   * and `latestInteraction`, every one of which was a finished string that
   * nothing recomputed. A message stayed "2m ago" forever, and the "local time"
   * was a literal rather than anything to do with the client's clock.
   */
  at: string;
  /** Drives the category chips. Derived on read when absent. */
  category?: MsgCategory;
  /** The client's real business location. */
  location?: string;
  /** IANA zone, e.g. "Africa/Johannesburg" — their current time is computed from it. */
  timeZone?: string;
};

/**
 * Seed fixtures.
 *
 * Timestamps are anchored to when the store is first written so the demo reads
 * sensibly, and are frozen from that point on — exactly like real messages.
 */
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

export const messages: Message[] = [
  {
    id: "bradley-burger",
    initials: "BB",
    color: "blue",
    name: "Bradley Burger",
    role: "CEO at Call Movers inc.",
    company: "Call Movers inc.",
    subject: "Proposal for Q3 development partnership",
    preview: "Hi Lang, thanks for the call earlier. I've attached the proposal and scope docs for review before Friday.",
    at: minutesAgo(2),
    category: "Follow-ups",
    unread: true,
    assigned: true,
    direction: "received",
    trashed: false,
    body: [
      "Hi Lang,",
      "Thanks for the call earlier — great to reconnect. As discussed, I've put together a proposal covering the Q3 development partnership, including scope, milestones and the revised budget.",
      "Please find the documents attached below. I'd love to get your feedback before Friday so we can lock in the timeline.",
      "Best,\nBradley",
    ],
    attachments: [
      {
        name: "Proposal.pdf",
        size: "2.1 MB",
        kind: "pdf",
        content: [
          "Q3 DEVELOPMENT PARTNERSHIP — PROPOSAL",
          "Prepared by Call Movers inc. for YourCRM",
          "",
          "1. OVERVIEW",
          "A three-month engagement covering CRM integration, data migration from the existing spreadsheet workflow, and staff onboarding.",
          "",
          "2. MILESTONES",
          "  M1 — Discovery and data audit ......... 2 weeks ..... $4,000",
          "  M2 — Integration build ................ 5 weeks ..... $12,000",
          "  M3 — Migration and onboarding ......... 3 weeks ..... $8,000",
          "",
          "3. TOTAL",
          "  $24,000, invoiced per milestone on completion.",
          "",
          "4. TERMS",
          "Payment within 14 days of each milestone invoice. Either party may end the engagement with 30 days' notice.",
          "",
          "5. NEXT STEPS",
          "Feedback requested before Friday so the start date can be confirmed.",
        ].join("\n"),
      },
      {
        name: "Scope.doc",
        size: "1.4 MB",
        kind: "doc",
        content: [
          "SCOPE OF WORK — Q3 PARTNERSHIP",
          "",
          "IN SCOPE",
          "  • Migration of ~4,000 contact records from spreadsheets",
          "  • Deal pipeline configuration (5 stages)",
          "  • Two custom reports: revenue by month, win rate by source",
          "  • Training: two sessions, up to 8 staff",
          "",
          "OUT OF SCOPE",
          "  • Telephony integration (quoted separately)",
          "  • Ongoing support beyond the 30-day handover period",
          "",
          "ASSUMPTIONS",
          "  • Source data is provided in CSV within week one",
          "  • A single point of contact is available for sign-off",
        ].join("\n"),
      },
    ],
    email: "BradleyB@gmail.com",
    phone: "+27 71 443 8872",
    location: "Cape Town, South Africa",
    timeZone: "Africa/Johannesburg",
    language: "English",
  },
  {
    id: "alex-carter",
    initials: "AC",
    color: "green",
    name: "Alex Carter",
    role: "Founder at Carter Co.",
    company: "Carter Co.",
    subject: "Re: Website revamp invoice",
    preview: "Payment has been sent through — please confirm you received the $500 for the first milestone.",
    at: minutesAgo(64),
    category: "Tasks",
    unread: true,
    assigned: false,
    direction: "received",
    trashed: false,
    body: [
      "Hi Lang,",
      "Just letting you know the payment for the first milestone ($500) has been sent through. Please confirm once it lands on your side.",
      "Looking forward to the next phase!",
      "Cheers,\nAlex",
    ],
    attachments: [
      {
        name: "Invoice-041.pdf",
        size: "0.6 MB",
        kind: "pdf",
        content: [
          "INVOICE 041",
          "Carter Co. — Website Revamp",
          "",
          "Milestone 1: Design and information architecture",
          "Amount: $500.00",
          "Status: PAID",
          "",
          "Remaining milestones:",
          "  M2 — Build ................ $1,200 (not yet invoiced)",
          "  M3 — Launch and handover .. $800  (not yet invoiced)",
          "",
          "Please confirm receipt.",
        ].join("\n"),
      },
    ],
    email: "alex@carterco.com",
    phone: "+27 71 443 8872",
    location: "Johannesburg, South Africa",
    timeZone: "Africa/Johannesburg",
    language: "English",
  },
  {
    id: "jamie-wilson",
    initials: "JW",
    color: "teal",
    name: "Jamie Wilson",
    role: "Ops Lead at Wilson & Co.",
    company: "Wilson & Co.",
    subject: "Meeting request — automation rollout",
    preview: "Could we set up 30 minutes next week to walk through the automation rollout plan?",
    at: minutesAgo(60 * 22),
    category: "Meeting Requests",
    unread: false,
    assigned: true,
    direction: "received",
    trashed: false,
    body: [
      "Hi Lang,",
      "We're ready to move on the automation rollout. Could we grab 30 minutes next week to align on the plan and timelines?",
      "Any afternoon works for me.",
      "Thanks,\nJamie",
    ],
    attachments: [],
    email: "jamie@wilsonco.com",
    phone: "+27 82 908 4410",
    location: "Durban, South Africa",
    timeZone: "Africa/Johannesburg",
    language: "English",
  },
  {
    id: "morgan-smith",
    initials: "MS",
    color: "amber",
    name: "Morgan Smith",
    role: "Director at Smith Solutions",
    company: "Smith Solutions",
    subject: "Re: Sales automation demo",
    preview: "Thanks for the demo — I've shared it internally and will circle back with questions.",
    at: minutesAgo(60 * 48),
    category: "Follow-ups",
    unread: false,
    assigned: false,
    direction: "sent",
    trashed: false,
    body: [
      "Hi Morgan,",
      "Thanks for making time for the demo. Let me know if the team has any questions after reviewing — happy to jump on another call.",
      "Best,\nLang",
    ],
    attachments: [],
    email: "morgan@smith.co.za",
    phone: "+27 71 987 6543",
    location: "Pretoria, South Africa",
    timeZone: "Africa/Johannesburg",
    language: "English",
  },
  {
    id: "jenny-lou",
    initials: "JL",
    color: "pink",
    name: "Jenny Lou",
    role: "Marketing at Lou Media",
    company: "Lou Media",
    subject: "Re: Referral introduction",
    preview: "Alex passed along your details — I'd love to learn more about how you work with agencies.",
    at: minutesAgo(60 * 50),
    // Proposes a specific slot ("would next Tuesday suit for an intro call"),
    // so it is a meeting request rather than an enquiry.
    category: "Meeting Requests",
    unread: false,
    assigned: false,
    direction: "sent",
    trashed: false,
    body: [
      "Hi Jenny,",
      "Great to connect — Alex speaks highly of your team. I've attached a short overview of how we typically partner with agencies.",
      "Would next Tuesday suit for an intro call?",
      "Warm regards,\nLang",
    ],
    attachments: [
      {
        name: "Overview.pdf",
        size: "1.1 MB",
        kind: "pdf",
        content: [
          "PARTNERING WITH AGENCIES — OVERVIEW",
          "",
          "HOW IT WORKS",
          "Agencies resell YourCRM to their own clients and manage those accounts from a single dashboard.",
          "",
          "COMMERCIALS",
          "  • 20% recurring commission on referred accounts",
          "  • No minimum volume",
          "  • Dedicated onboarding for the agency team",
          "",
          "TYPICAL TIMELINE",
          "  Week 1 — agency onboarding",
          "  Week 2 — first client migrated",
          "  Week 4 — handover complete",
        ].join("\n"),
      },
    ],
    email: "j.lou@loumedia.co.uk",
    phone: "+44 20 7946 0812",
    // A different zone on purpose: the point of showing a client's local time is
    // knowing whether it is a reasonable hour where *they* are.
    location: "London, United Kingdom",
    timeZone: "Europe/London",
    language: "English",
  },
];

export const inboxFilters = [
  "All",
  "Unread",
  "Assigned to me",
  "Sent",
  "Received",
  "Trash",
] as const;
export type InboxFilter = (typeof inboxFilters)[number];
