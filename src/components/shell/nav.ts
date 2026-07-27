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
  badge?: string;
  dot?: boolean;
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
      { label: "Inbox", href: "/inbox", icon: Inbox, badge: "12" },
      { label: "Calendar", href: "/calendar", icon: CalendarDays, dot: true },
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
