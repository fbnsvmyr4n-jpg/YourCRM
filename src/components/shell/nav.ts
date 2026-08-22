import {
  BarChart3,
  CalendarDays,
  Handshake,
  Headphones,
  Home,
  Inbox,
  KanbanSquare,
  LifeBuoy,
  MessageSquare,
  Settings,
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
      { label: "Settings", href: "/settings", icon: Settings },
      { label: "Support & FAQs", href: "/support", icon: LifeBuoy },
    ],
  },
];
