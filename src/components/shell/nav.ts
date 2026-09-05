import {
  BarChart3,
  Briefcase,
  CalendarDays,
  Handshake,
  Headphones,
  Home,
  Inbox,
  KanbanSquare,
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
  count?: "inbox" | "calendarToday";
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
      { label: "Projects", href: "/projects", icon: Briefcase },
      { label: "Inbox", href: "/inbox", icon: Inbox, count: "inbox" },
      { label: "Calendar", href: "/calendar", icon: CalendarDays, count: "calendarToday" },
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
export function visibleNav(crmAccess: boolean): NavSection[] {
  if (crmAccess) return NAV;
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.needsCrm === false),
  })).filter((section) => section.items.length > 0);
}
