import {
  BarChart3,
  Building2,
  Briefcase,
  CalendarDays,
  ClipboardList,
  FileText,
  Receipt,
  Handshake,
  Headphones,
  Home,
  Inbox,
  KanbanSquare,
  ListChecks,
  LifeBuoy,
  MessageSquare,
  NotebookPen,
  Settings,
  Tags,
  Target,
  Users,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /**
   * Which live count this item shows, if any.
   *
   * Not a number. This file is a static config, and the one number it used to
   * hold — `badge: "12"` on Inbox — was shown to every customer regardless of
   * what was in their inbox. Naming the count instead means the value can only
   * come from the database.
   */
  count?: "inbox" | "calendarToday" | "tasksDue";
  /**
   * Whether this screen shows customer records.
   *
   * Absent means YES, which is the fail-closed direction and matches the
   * server: `withTenantPage` requires CRM access unless told otherwise, so a
   * page added by somebody who never read this file is hidden from IT and
   * accounts rather than exposed to them. Only the two screens that are
   * genuinely about the account rather than its customers say otherwise.
   */
  needsCrm?: false;
  /**
   * Whether this screen is MONEY PAPERWORK — a quotation, an order, an invoice.
   *
   * A separate question from `needsCrm` because it has a different answer for
   * the same person: a bookkeeper may not read somebody's call history and must
   * be able to open an unpaid invoice. Marked here, these survive the filter for
   * a reader who holds the money tier but not the customer one.
   */
  isMoney?: true;
  /**
   * Pages that belong under this one, shown nested beneath it.
   *
   * Grouping only. The children are TOP-LEVEL routes — `/quotes`, not
   * `/projects/quotes` — because `/projects/[id]` already owns that space:
   * a static child silently wins over the dynamic segment, and a project
   * whose id matched would become unreachable with nothing to explain why.
   * The hierarchy a reader needs is in this sidebar, not in the path.
   */
  children?: NavItem[];
};

export type NavSection = {
  heading?: string;
  items: NavItem[];
};

export const NAV: NavSection[] = [
  {
    items: [{ label: "Home", href: "/", icon: Home }],
  },
  {
    heading: "Communication",
    items: [
      { label: "Chat", href: "/chat", icon: MessageSquare },
      { label: "Voice Agents", href: "/voice-agents", icon: Headphones },
      { label: "Contacts", href: "/contacts", icon: Users },
      /* Was "Companies". A client list is a filing cabinet; what people
         actually navigate to is the work — "the Heineken warehouse job" — so
         the front door is the projects and the company is how they are filed.
         Companies itself is still a screen, reached from Projects, because
         renaming and tidying them did not stop being necessary. */
      {
        label: "Projects",
        href: "/projects",
        icon: Briefcase,
        /* The paperwork a job produces, each as its own list across every
           project — because "where is that quote" is a question asked
           without remembering which job it was on. */
        children: [
          { label: "Quotes", href: "/quotes", icon: FileText, isMoney: true },
          /* The money coming IN. Had no screen of its own at all until now:
             invoices lived only inside a job, which is the one place the
             finance role cannot go. */
          { label: "Invoices", href: "/invoices", icon: Receipt, isMoney: true },
          { label: "Purchase orders", href: "/purchase-orders", icon: ClipboardList, isMoney: true },
        ],
      },
      /* Its own row at last.
         It was reachable only from a "Manage companies" link in the Projects
         header — a screen you had to already be somewhere else to find, for the
         list of who every job belongs to. Beside Contacts, because that is the
         question it answers: people, and the firms they work for. */
      { label: "Companies", href: "/companies", icon: Building2 },
      { label: "Inbox", href: "/inbox", icon: Inbox, count: "inbox" },
      { label: "Calendar", href: "/calendar", icon: CalendarDays, count: "calendarToday" },
      /* Beside the Calendar: both answer "what is on today". The badge is the
         reader's own tasks due today or late — work they can clear. */
      { label: "Tasks", href: "/tasks", icon: ListChecks, count: "tasksDue" },
    ],
  },
  {
    heading: "Pipeline",
    items: [
      { label: "Deals", href: "/deals", icon: KanbanSquare },
      { label: "Meetings", href: "/meetings", icon: Handshake },
      { label: "Leads", href: "/leads", icon: Target },
      { label: "Reports", href: "/reports", icon: BarChart3 },
    ],
  },
  {
    heading: "Other",
    items: [
      /* Above Settings, and not in Pipeline: notes are not a daily-glance
         figure, they are something you come looking for. */
      { label: "Notes", href: "/notes", icon: NotebookPen },
      /* Reference data you maintain rather than work in, so it sits with Notes
         rather than in Pipeline — but NOT in Settings, because a price list
         grows past what a settings area should hold and needs its own search. */
      { label: "Price list", href: "/pricing", icon: Tags },
      /* The two screens an IT admin or a bookkeeper can actually use: their own
         account, the team, billing — and the help pages, which contain nothing
         at all about anybody's customers. */
      { label: "Settings", href: "/settings", icon: Settings, needsCrm: false },
      { label: "Support & FAQs", href: "/support", icon: LifeBuoy, needsCrm: false },
    ],
  },
];

/**
 * The sidebar for one reader.
 *
 * Presentation only. What actually stops an IT admin opening /contacts is
 * `withTenantPage` refusing, and typing the URL by hand gets them redirected
 * whatever this returns — the rule this project keeps: hiding a control is
 * tidiness, the refusal in the server is the security.
 *
 * Sections that empty out are dropped, so a reader without CRM access does not
 * see a "PIPELINE" heading with nothing under it.
 */
export function visibleNav(crmAccess: boolean, moneyAccess = crmAccess): NavSection[] {
  if (crmAccess) return NAV;

  return NAV.map((section) => ({
    ...section,
    items: section.items.flatMap((item) => {
      /* Their own account and the help pages: nothing about anybody's
         customers, so every reader keeps them. */
      if (item.needsCrm === false) return [{ ...item, children: undefined }];

      /*
         A PARENT THEY MAY NOT OPEN, HIDING CHILDREN THEY MAY.

         Projects is customer work, and Quotes and Purchase orders hang beneath
         it — so a bookkeeper, filtered on the parent, lost the two screens
         their whole job happens on. The nesting is a convenience for people who
         have both; for somebody who only has the paperwork it is a locked door
         with their desk behind it.

         So the money children are lifted to the top level instead. They are
         top-level routes either way — see the note on `children` — so nothing
         moves but where the row is drawn.
      */
      const money = (item.children ?? []).filter((child) => child.isMoney);
      if (moneyAccess && money.length > 0) return money.map((child) => ({ ...child }));
      return [];
    }),
  })).filter((section) => section.items.length > 0);
}
