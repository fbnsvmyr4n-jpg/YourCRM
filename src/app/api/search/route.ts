import { NextResponse } from "next/server";
import type { AvatarColor } from "@/components/ui/Avatar";
import { listContacts } from "@/server/repos/contacts";
import { listDeals } from "@/server/repos/deals";
import { listMeetings } from "@/server/repos/meetings";
import { listMessages } from "@/server/repos/inbox";
import { getSettings } from "@/server/repos/settings";
import { instantToWallClock } from "@/lib/zoned";
import { canAccessCrm } from "@/server/permissions";
import { requireTenant, withCurrentTenant } from "@/server/tenant-session";

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

function money(cents: number) {
  const n = Math.round(cents / 100);
  if (n >= 1000) {
    const k = n / 1000;
    return `$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return `$${n}`;
}

const AVATAR_COLORS: AvatarColor[] = ["blue", "green", "amber", "purple", "pink", "teal"];

function paletteFor(id: string): AvatarColor {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase() || "—";

export async function GET() {
  /**
   * This returns every contact, deal, meeting and message the caller can see.
   *
   * A route handler is covered by neither the `(app)` layout guard nor the
   * checks inside server actions — it is its own public endpoint. Unauthenticated
   * it once answered with the entire dataset: 41 records including names,
   * companies, deal values and message subjects.
   *
   * `requireTenant` now settles both questions at once. It throws when there is
   * no session, and it establishes WHICH customer's records may be returned —
   * the half that did not exist before, and the half that matters once there is
   * more than one customer.
   */
  let role: string;
  try {
    role = (await requireTenant()).role;
  } catch {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  /*
     Search is the fastest route to a customer's name there is — it returns
     contacts, deals, meetings and message subjects in one call, which is
     exactly what made its unauthenticated version a Critical finding. IT and
     accounts have no business in it.

     `withCurrentTenant` below refuses anyway; this makes the answer an empty
     result with a 403 rather than an exception.
  */
  if (!canAccessCrm(role)) {
    return NextResponse.json(
      { error: "This account does not have access to customer records.", items: [] },
      { status: 403 }
    );
  }

  const items = await withCurrentTenant(async (q) => {
    const settings = await getSettings(q);
    const contacts = await listContacts(q);
    const deals = await listDeals(q);
    const meetings = await listMeetings(q);
    // Trashed mail is excluded by the folder itself rather than by a flag the
    // loop has to remember to check.
    const messages = await listMessages(q, "inbox");

    const nameOf = new Map(contacts.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]));
    const out: SearchItem[] = [];

    for (const c of contacts) {
      const name = `${c.firstName} ${c.lastName}`.trim();
      out.push({
        id: `contact-${c.id}`,
        // The same person appears once. They used to appear twice — as a
        // Contact and as a Lead — because they were two records.
        type: c.hasOpenDeal && !c.isClient ? "Lead" : "Contact",
        title: name,
        subtitle: [c.info, c.isClient ? "Client" : c.hasOpenDeal ? "In progress" : null]
          .filter(Boolean)
          .join(" · "),
        href: c.hasOpenDeal && !c.isClient ? "/leads" : "/contacts",
        initials: initialsOf(name),
        color: paletteFor(c.id),
      });
    }

    for (const d of deals) {
      const who = d.contactId ? (nameOf.get(d.contactId) ?? "") : "";
      out.push({
        id: `deal-${d.id}`,
        type: "Deal",
        title: d.title,
        subtitle: [who, money(d.valueCents)].filter(Boolean).join(" · "),
        href: "/deals",
        initials: initialsOf(who || d.title),
        color: paletteFor(d.id),
      });
    }

    for (const m of meetings) {
      const who = m.contactId ? (nameOf.get(m.contactId) ?? "") : "";
      // Shown in the business's own zone, so the result matches the calendar.
      const when = instantToWallClock(m.scheduledAt, settings.timeZone);
      out.push({
        id: `meeting-${m.id}`,
        type: "Meeting",
        title: [who, m.topic].filter(Boolean).join(" — ") || "Meeting",
        subtitle: when ? `${when.date} · ${when.time}` : "",
        href: "/meetings",
        initials: initialsOf(who || m.topic),
        color: paletteFor(m.id),
      });
    }

    for (const m of messages) {
      const who = m.contactId ? (nameOf.get(m.contactId) ?? "Unknown sender") : "Unknown sender";
      out.push({
        id: `message-${m.id}`,
        type: "Message",
        title: who,
        subtitle: m.subject,
        href: "/inbox",
        initials: initialsOf(who),
        color: paletteFor(m.id),
      });
    }

    return out;
  });

  return NextResponse.json({ items });
}
