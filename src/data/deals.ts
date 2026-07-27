import type { AvatarColor } from "@/components/ui/Avatar";

/** Allowed values first, types derived — see the note in `data/contacts.ts`. */
export const STAGE_IDS = ["lead", "qualified", "proposal", "negotiation", "won"] as const;
export type StageId = (typeof STAGE_IDS)[number];

/** Where a deal lands when its stored stage isn't a real stage (bad legacy row). */
export const FALLBACK_STAGE: StageId = "lead";

export type Stage = {
  id: StageId;
  label: string;
  color: string; // css var
  soft: string;
};

export const STAGES: Stage[] = [
  { id: "lead", label: "Lead In", color: "var(--accent)", soft: "var(--accent-soft)" },
  { id: "qualified", label: "Qualified", color: "var(--purple)", soft: "var(--purple-soft)" },
  { id: "proposal", label: "Proposal", color: "var(--amber)", soft: "var(--amber-soft)" },
  { id: "negotiation", label: "Negotiation", color: "#f97316", soft: "rgba(249,115,22,0.12)" },
  { id: "won", label: "Closed Won", color: "var(--green)", soft: "var(--green-soft)" },
];

export type Deal = {
  id: string;
  title: string;
  contact: string;
  company: string;
  initials: string;
  color: AvatarColor;
  value: number;
  stage: StageId;
  owner: string;
  closeDate: string;
  /**
   * ISO timestamp of when this deal actually reached "won". Set by the repo on
   * the transition into that stage, and cleared if it moves back out — so
   * revenue reporting is driven by a real recorded event rather than an
   * invented figure. Absent on deals that have never been won.
   */
  wonAt?: string;
};

export const deals: Deal[] = [
  {
    id: "deal-burger-holdings",
    title: "Q3 Development Partnership",
    contact: "Bradley Burger",
    company: "Burger Holdings",
    initials: "BB",
    color: "blue",
    value: 24000,
    stage: "negotiation",
    owner: "Lang Lee",
    closeDate: "30 Jul 2026",
  },
  {
    id: "deal-carter-web",
    title: "Website Development",
    contact: "Alex Carter",
    company: "Carter Co.",
    initials: "AC",
    color: "teal",
    value: 8500,
    stage: "won",
    owner: "Lang Lee",
    closeDate: "18 Jul 2026",
    wonAt: "2026-07-18T14:20:00.000Z",
  },
  {
    id: "deal-wilson-crm",
    title: "CRM Implementation",
    contact: "Jamie Wilson",
    company: "Wilson & Co.",
    initials: "JW",
    color: "green",
    value: 15000,
    stage: "proposal",
    owner: "Lang Lee",
    closeDate: "05 Aug 2026",
  },
  {
    id: "deal-smith-automation",
    title: "Sales Automation Suite",
    contact: "Morgan Smith",
    company: "Smith Solutions",
    initials: "MS",
    color: "amber",
    value: 12000,
    stage: "qualified",
    owner: "Lang Lee",
    closeDate: "12 Aug 2026",
  },
  {
    id: "deal-brown-proposal",
    title: "Enterprise Rollout",
    contact: "Taylor Brown",
    company: "Brown Enterprises",
    initials: "TB",
    color: "purple",
    value: 32000,
    stage: "qualified",
    owner: "Lang Lee",
    closeDate: "20 Aug 2026",
  },
  {
    id: "deal-stark-industries",
    title: "Platform Migration",
    contact: "Tony Stark",
    company: "Stark Industries",
    initials: "TS",
    color: "pink",
    value: 48000,
    stage: "lead",
    owner: "Lang Lee",
    closeDate: "28 Aug 2026",
  },
  {
    id: "deal-lou-media",
    title: "Marketing Retainer",
    contact: "Jenny Lou",
    company: "Lou Media",
    initials: "JL",
    color: "pink",
    value: 6000,
    stage: "lead",
    owner: "Lang Lee",
    closeDate: "01 Sep 2026",
  },
  {
    id: "deal-stone-works",
    title: "Onboarding & Training",
    contact: "John Stone",
    company: "Stone Works",
    initials: "JS",
    color: "green",
    value: 9500,
    stage: "proposal",
    owner: "Lang Lee",
    closeDate: "10 Sep 2026",
  },
  {
    id: "deal-cole-media",
    title: "Annual Support Contract",
    contact: "Alison Cole",
    company: "Cole Media",
    initials: "AC",
    color: "teal",
    value: 14000,
    stage: "won",
    owner: "Lang Lee",
    closeDate: "15 Jul 2026",
    wonAt: "2026-07-15T09:05:00.000Z",
  },
];
