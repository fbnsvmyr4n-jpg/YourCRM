import type { AvatarColor } from "@/components/ui/Avatar";

export type MsgChannel = "amber" | "green" | "blue";
export type Attachment = { name: string; size: string; kind: "pdf" | "doc" };
export type MsgFolder = "unread" | "assigned" | "sent" | "received" | "trash";

export type Message = {
  id: string;
  initials: string;
  color: AvatarColor;
  name: string;
  role: string;
  company: string;
  subject: string;
  preview: string;
  time: string;
  ago: string;
  channel: MsgChannel;
  unread: boolean;
  assigned: boolean;
  direction: "sent" | "received";
  trashed: boolean;
  body: string[];
  attachments: Attachment[];
  email: string;
  phone: string;
  localTime: string;
  language: string;
  firstInteraction: { date: string; time: string };
  latestInteraction: { date: string; time: string };
};

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
    time: "10:31",
    ago: "2m ago",
    channel: "amber",
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
      { name: "Proposal.pdf", size: "2.1 MB", kind: "pdf" },
      { name: "Scope.doc", size: "1.4 MB", kind: "doc" },
    ],
    email: "BradleyB@gmail.com",
    phone: "+27 71 443 8872",
    localTime: "16 May 2024, 10:31 AM",
    language: "English",
    firstInteraction: { date: "12 May 2024", time: "09:15 AM" },
    latestInteraction: { date: "16 May 2024", time: "10:31 AM" },
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
    time: "09:16",
    ago: "1h ago",
    channel: "amber",
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
    attachments: [{ name: "Invoice-041.pdf", size: "0.6 MB", kind: "pdf" }],
    email: "alex@carterco.com",
    phone: "+27 71 443 8872",
    localTime: "16 May 2024, 09:16 AM",
    language: "English",
    firstInteraction: { date: "02 May 2024", time: "14:20 PM" },
    latestInteraction: { date: "16 May 2024", time: "09:16 AM" },
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
    time: "Yesterday",
    ago: "1d ago",
    channel: "green",
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
    localTime: "15 May 2024, 04:45 PM",
    language: "English",
    firstInteraction: { date: "28 Apr 2024", time: "11:00 AM" },
    latestInteraction: { date: "15 May 2024", time: "16:45 PM" },
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
    time: "2d ago",
    ago: "2d ago",
    channel: "blue",
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
    localTime: "14 May 2024, 12:10 PM",
    language: "English",
    firstInteraction: { date: "20 Apr 2024", time: "10:30 AM" },
    latestInteraction: { date: "14 May 2024", time: "12:10 PM" },
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
    time: "2d ago",
    ago: "2d ago",
    channel: "blue",
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
    attachments: [{ name: "Overview.pdf", size: "1.1 MB", kind: "pdf" }],
    email: "j.lou@example.com",
    phone: "+27 12 345 6789",
    localTime: "14 May 2024, 09:05 AM",
    language: "English",
    firstInteraction: { date: "13 May 2024", time: "16:00 PM" },
    latestInteraction: { date: "14 May 2024", time: "09:05 AM" },
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
