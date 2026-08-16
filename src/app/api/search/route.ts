import { NextResponse } from "next/server";
import type { AvatarColor } from "@/components/ui/Avatar";
import { listContacts } from "@/server/contacts-repo";
import { listDeals } from "@/server/deals-repo";
import { listLeads } from "@/server/leads-repo";
import { listMeetings } from "@/server/meetings-repo";
import { listMessages } from "@/server/inbox-repo";
import { getCurrentUser } from "@/server/session";

export const dynamic = "force-dynamic";

export type SearchItem = {
  id: string;
  type: "Contact" | "Lead" | "Deal" | "Meeting" | "Message";
  title: string;
  subtitle: string;
  href: string;
  initials: string;
  color: AvatarColor;
};

function money(n: number) {
  if (n >= 1000) {
    const k = n / 1000;
    return `$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return `$${n}`;
}

export async function GET() {
  // This returns every contact, lead, deal, meeting and message in the CRM.
  // A route handler is not covered by the `(app)` layout guard *or* by the
  // `requireUser()` call in the server actions — it is its own public endpoint.
  // Unauthenticated, it answered with the entire dataset: 41 records including
  // names, companies, deal values and message subjects.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const [contacts, leads, deals, meetings, messages] = await Promise.all([
    listContacts(),
    listLeads(),
    listDeals(),
    listMeetings(),
    listMessages(),
  ]);

  const items: SearchItem[] = [];

  for (const c of contacts) {
    items.push({
      id: `contact-${c.id}`,
      type: "Contact",
      title: `${c.firstName} ${c.lastName}`,
      subtitle: [c.company, c.info].filter(Boolean).join(" · "),
      href: "/contacts",
      initials: c.initials,
      color: c.color,
    });
  }
  for (const l of leads) {
    items.push({
      id: `lead-${l.id}`,
      type: "Lead",
      title: l.name,
      subtitle: `${l.company} · ${l.status}`,
      href: "/leads",
      initials: l.initials,
      color: l.color,
    });
  }
  for (const d of deals) {
    items.push({
      id: `deal-${d.id}`,
      type: "Deal",
      title: d.title,
      subtitle: `${d.contact} · ${money(d.value)}`,
      href: "/deals",
      initials: d.initials,
      color: d.color,
    });
  }
  for (const m of meetings) {
    items.push({
      id: `meeting-${m.id}`,
      type: "Meeting",
      title: `${m.name} — ${m.topic}`,
      subtitle: `${m.when} · ${m.time}`,
      href: "/meetings",
      initials: m.initials,
      color: m.color,
    });
  }
  for (const m of messages) {
    if (m.trashed) continue;
    items.push({
      id: `message-${m.id}`,
      type: "Message",
      title: m.name,
      subtitle: m.subject,
      href: "/inbox",
      initials: m.initials,
      color: m.color,
    });
  }

  return NextResponse.json({ items });
}
