import type { AvatarColor } from "@/components/ui/Avatar";

/**
 * Allowed values live in these arrays and the types are derived from them, so
 * the runtime list a server action validates against can never drift out of
 * sync with the compile-time union.
 */
export const CONTACT_TYPES = ["lead", "client"] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const CONTACT_STATUSES = ["Active", "Follow-up", "Inactive", "New"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export type Contact = {
  id: string;
  firstName: string;
  lastName: string;
  initials: string;
  color: AvatarColor;
  type: ContactType;
  status: ContactStatus;
  email: string;
  phone: string;
  company: string;
  companyInfo: string;
  owner: string;
  info: string;
  activity: { title: string; date: string }[];
};

export const contacts: Contact[] = [
  {
    id: "bradley-burger",
    firstName: "Bradley",
    lastName: "Burger",
    initials: "BB",
    color: "blue",
    type: "client",
    status: "Active",
    email: "bradley.burger@gmail.com",
    phone: "+27 82 123 4567",
    company: "Burger Holdings",
    companyInfo: "Real Estate Investment & Development",
    owner: "Lang Lee",
    info: "CEO — Real Estate Investment",
    activity: [
      { title: "Contact activity explained", date: "23 May 2024, 9:41 AM" },
      { title: "Sent proposal for Q3 development", date: "21 May 2024, 2:15 PM" },
      { title: "Discovery call completed", date: "18 May 2024, 11:00 AM" },
    ],
  },
  {
    id: "taylor-brown",
    firstName: "Taylor",
    lastName: "Brown",
    initials: "TB",
    color: "purple",
    type: "lead",
    status: "Follow-up",
    email: "taylor@brown.com",
    phone: "+27 82 555 1200",
    company: "Brown Enterprises",
    companyInfo: "Interested in CRM Implementation",
    owner: "Lang Lee",
    info: "Interested in CRM Implementation",
    activity: [
      { title: "First contact via web form", date: "22 May 2024, 10:02 AM" },
      { title: "Sent intro email", date: "22 May 2024, 10:20 AM" },
    ],
  },
  {
    id: "alex-carter",
    firstName: "Alex",
    lastName: "Carter",
    initials: "AC",
    color: "teal",
    type: "client",
    status: "Active",
    email: "alex@carterco.com",
    phone: "+27 71 443 8872",
    company: "Carter Co.",
    companyInfo: "Website Development & Design",
    owner: "Lang Lee",
    info: "Website Development project",
    activity: [
      { title: "Invoice paid — $500", date: "18 Jul 2025, 10:30 AM" },
      { title: "Project kickoff meeting", date: "12 Jul 2025, 9:00 AM" },
    ],
  },
  {
    id: "jamie-wilson",
    firstName: "Jamie",
    lastName: "Wilson",
    initials: "JW",
    color: "green",
    type: "client",
    status: "Active",
    email: "jamie@wilsonco.com",
    phone: "+27 82 908 4410",
    company: "Wilson & Co.",
    companyInfo: "CRM Implementation & Automation",
    owner: "Lang Lee",
    info: "CRM Implementation",
    activity: [{ title: "Signed annual contract", date: "17 Jul 2025, 2:15 PM" }],
  },
  {
    id: "morgan-smith",
    firstName: "Morgan",
    lastName: "Smith",
    initials: "MS",
    color: "amber",
    type: "lead",
    status: "New",
    email: "morgan@smith.co.za",
    phone: "+27 71 987 6543",
    company: "Smith Solutions",
    companyInfo: "Looking for Sales Automation",
    owner: "Lang Lee",
    info: "Looking for Sales Automation",
    activity: [{ title: "Requested a demo", date: "20 May 2024, 9:15 AM" }],
  },
  {
    id: "jenny-lou",
    firstName: "Jenny",
    lastName: "Lou",
    initials: "JL",
    color: "pink",
    type: "lead",
    status: "Follow-up",
    email: "j.lou@example.com",
    phone: "+27 12 345 6789",
    company: "Lou Media",
    companyInfo: "Referral — Marketing services",
    owner: "Lang Lee",
    info: "Referral lead — Marketing",
    activity: [{ title: "Referred by Alex Carter", date: "20 May 2024, 9:15 AM" }],
  },
];
