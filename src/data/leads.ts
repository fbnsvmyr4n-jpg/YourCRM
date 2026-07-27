import type { AvatarColor } from "@/components/ui/Avatar";


/** Allowed values first, types derived — see the note in `data/contacts.ts`. */
export const LEAD_SOURCES = ["Google Ads", "Facebook", "Referral", "Phone Call"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_STATUSES = ["Closed", "Follow-up Required"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type LeadCard = {
  id: string;
  initials: string;
  color: AvatarColor;
  name: string;
  email: string;
  phone: string;
  location: string;
  company: string;
  status: LeadStatus;
  source: LeadSource;
  /** ISO timestamp of when the lead was captured. Absent on rows created
   *  before this field existed — such leads are simply excluded from
   *  time-windowed counts rather than assumed to be recent. */
  createdAt?: string;
};

export const leadCards: LeadCard[] = [
  {
    id: "john-abshire",
    initials: "JA",
    color: "blue",
    name: "John Abshire",
    email: "john.abshire@example.com",
    phone: "(555) 123 4567",
    location: "NY, New York City",
    company: "Abshire Group",
    status: "Closed",
    source: "Google Ads",
  },
  {
    id: "tony-stark",
    initials: "TS",
    color: "pink",
    name: "Tony Stark",
    email: "tony.s@example.com",
    phone: "+27 12 345 6789",
    location: "NY, New York City",
    company: "Stark Industries",
    status: "Follow-up Required",
    source: "Facebook",
  },
  {
    id: "jenny-lou-lead",
    initials: "JL",
    color: "purple",
    name: "Jenny Lou",
    email: "j.lou@example.com",
    phone: "+27 12 345 6789",
    location: "NY, New York City",
    company: "Lou Media",
    status: "Follow-up Required",
    source: "Referral",
  },
  {
    id: "tristen-mann",
    initials: "TM",
    color: "amber",
    name: "Tristen Mann",
    email: "tristen.m@example.com",
    phone: "(555) 123 4567",
    location: "NY, New York City",
    company: "Mann & Co.",
    status: "Closed",
    source: "Facebook",
  },
  {
    id: "john-stone",
    initials: "JS",
    color: "green",
    name: "John Stone",
    email: "john.stone@example.com",
    phone: "+27 12 345 6789",
    location: "NY, New York City",
    company: "Stone Works",
    status: "Follow-up Required",
    source: "Referral",
  },
  {
    id: "alison-cole",
    initials: "AC",
    color: "teal",
    name: "Alison Cole",
    email: "alison@example.com",
    phone: "(555) 123 4567",
    location: "NY, New York City",
    company: "Cole Media",
    status: "Closed",
    source: "Facebook",
  },
];
