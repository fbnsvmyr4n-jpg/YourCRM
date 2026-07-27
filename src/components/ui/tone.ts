import {
  BarChart3,
  CalendarDays,
  CalendarPlus,
  DollarSign,
  FileText,
  Headphones,
  MessageSquare,
  Phone,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

export type Tone = "blue" | "green" | "amber" | "red" | "purple";

export const toneStyles: Record<Tone, { color: string; soft: string }> = {
  blue: { color: "var(--accent)", soft: "var(--accent-soft)" },
  green: { color: "var(--green)", soft: "var(--green-soft)" },
  amber: { color: "var(--amber)", soft: "var(--amber-soft)" },
  red: { color: "var(--red)", soft: "var(--red-soft)" },
  purple: { color: "var(--purple)", soft: "var(--purple-soft)" },
};

export const iconMap: Record<string, LucideIcon> = {
  calendar: CalendarDays,
  "calendar-plus": CalendarPlus,
  "user-plus": UserPlus,
  file: FileText,
  "file-text": FileText,
  phone: Phone,
  headphones: Headphones,
  "bar-chart": BarChart3,
  dollar: DollarSign,
  message: MessageSquare,
};
