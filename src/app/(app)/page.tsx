import Link from "next/link";
import { ChevronRight, MoreHorizontal, Sparkles } from "lucide-react";
import { Avatar, type AvatarColor } from "@/components/ui/Avatar";
import { AreaChart } from "@/components/ui/AreaChart";
import { Card, CardHeader, ViewAll } from "@/components/ui/Card";
import { iconMap, toneStyles, type Tone } from "@/components/ui/tone";
import { listContacts } from "@/server/contacts-repo";
import { listWonDeals, weeklyRevenue } from "@/server/deals-repo";
import { listLeads } from "@/server/leads-repo";
import { listMeetings } from "@/server/meetings-repo";
import { listMessages } from "@/server/inbox-repo";

export const dynamic = "force-dynamic";

const USER = "Lang";

function greeting(hour: number) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** "today" / "yesterday" / "3 days ago" / a date, from a real timestamp. */
function relativeDay(iso: string, now: Date) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export default async function DashboardPage() {
  const [contacts, leads, meetings, messages, wonDeals, revenueSeries] = await Promise.all([
    listContacts(),
    listLeads(),
    listMeetings(),
    listMessages(),
    listWonDeals(),
    weeklyRevenue(),
  ]);

  const now = new Date();
  const dateLabel = now.toLocaleDateString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  // ---- derived, real numbers ----
  const clients = contacts.filter((c) => c.type === "client");
  const openLeads = leads.filter((l) => l.status === "Follow-up Required");
  const meetingsToday = meetings.filter((m) => m.when === "Today");
  const unread = messages.filter((m) => m.unread && !m.trashed);

  const heroStats = [
    { icon: "user-plus", tone: "blue" as Tone, label: "Contacts", value: contacts.length },
    { icon: "bar-chart", tone: "amber" as Tone, label: "Open Leads", value: openLeads.length },
    { icon: "calendar", tone: "purple" as Tone, label: "Meetings Today", value: meetingsToday.length },
    { icon: "message", tone: "green" as Tone, label: "Unread", value: unread.length },
  ];

  // Real money from real records: won deals carry the value the user entered
  // and the date they actually closed.
  const revenueRows = wonDeals.map((d) => ({
    id: d.id,
    initials: d.initials,
    color: d.color,
    client: d.contact,
    company: d.company,
    title: d.title,
    wonAt: d.wonAt,
    amount: d.value,
  }));
  const revenueTotal = wonDeals.reduce((sum, d) => sum + d.value, 0);

  const focus = [
    {
      icon: "calendar",
      tone: "red" as Tone,
      title: `${meetingsToday.length} meeting${meetingsToday.length === 1 ? "" : "s"} today`,
      sub: meetingsToday[0] ? `Next: ${meetingsToday[0].time} with ${meetingsToday[0].name}` : "Nothing on the calendar",
    },
    {
      icon: "user-plus",
      tone: "amber" as Tone,
      title: `${openLeads.length} lead${openLeads.length === 1 ? "" : "s"} need follow-up`,
      sub: openLeads[0] ? `Start with ${openLeads[0].name}` : "You're all caught up",
    },
    {
      icon: "message",
      tone: "blue" as Tone,
      title: `${unread.length} unread message${unread.length === 1 ? "" : "s"}`,
      sub: unread[0] ? `From ${unread[0].name}` : "Inbox zero 🎉",
    },
    {
      icon: "dollar",
      tone: "green" as Tone,
      // Deals closed means *deals*, not leads marked closed — those are
      // different records and conflating them overstated the number.
      title: `${wonDeals.length} deal${wonDeals.length === 1 ? "" : "s"} closed`,
      sub: `$${revenueTotal.toLocaleString()} won · ${clients.length} active client${clients.length === 1 ? "" : "s"}`,
    },
  ];

  const received = [...messages].filter((m) => m.direction === "received" && !m.trashed);
  const activity = [
    leads[0] && { icon: "user-plus", tone: "blue" as Tone, text: `New lead: ${leads[0].name}`, time: "just now" },
    meetings[0] && {
      icon: "calendar",
      tone: "red" as Tone,
      text: `Meeting: ${meetings[0].name} — ${meetings[0].topic}`,
      time: meetings[0].when.toLowerCase(),
    },
    wonDeals[0] && {
      icon: "dollar",
      tone: "green" as Tone,
      text: `Deal won: ${wonDeals[0].title} — $${wonDeals[0].value.toLocaleString()}`,
      time: relativeDay(wonDeals[0].wonAt, now),
    },
    received[0] && {
      icon: "message",
      tone: "purple" as Tone,
      text: `New message from ${received[0].name}`,
      time: received[0].ago,
    },
  ].filter(Boolean) as { icon: string; tone: Tone; text: string; time: string }[];

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-up">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_346px]">
        {/* ---------------- MAIN COLUMN ---------------- */}
        <div className="flex flex-col gap-5">
          <Hero
            greeting={greeting(now.getHours())}
            date={dateLabel}
            summary={`You have ${meetingsToday.length} meeting${meetingsToday.length === 1 ? "" : "s"} and ${openLeads.length} follow-up${openLeads.length === 1 ? "" : "s"} today.`}
            stats={heroStats}
          />

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <RevenueOverview series={revenueSeries} total={revenueTotal} />
            <RevenueReceived rows={revenueRows} now={now} />
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ThisWeek
              openLeads={openLeads.length}
              totalLeads={leads.length}
              clients={clients.length}
              totalContacts={contacts.length}
            />
            <Connections items={openLeads.slice(0, 3)} />
          </div>

          <Reminders items={meetings.slice(0, 4)} />
        </div>

        {/* ---------------- RIGHT RAIL ---------------- */}
        <div className="flex flex-col gap-5">
          <TodaysFocus items={focus} />
          <QuickActions />
          <ActivityFeed items={activity} />
        </div>
      </div>
    </div>
  );
}

/* ---------------- Hero ---------------- */

function Hero({
  greeting,
  date,
  summary,
  stats,
}: {
  greeting: string;
  date: string;
  summary: string;
  stats: { icon: string; tone: Tone; label: string; value: number }[];
}) {
  return (
    <Card className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(120% 140% at 0% 0%, var(--accent-soft), transparent 55%), radial-gradient(120% 140% at 100% 0%, var(--purple-soft), transparent 55%)",
        }}
      />
      <div className="relative">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-faint">{date}</p>
            <h2 className="mt-1 text-2xl font-bold tracking-tight sm:text-[27px]">
              {greeting}, {USER} 👋
            </h2>
            <p className="mt-1.5 text-sm text-muted">{summary}</p>
          </div>
          <Link
            href="/meetings"
            className="btn-accent focus-ring flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"
          >
            Schedule Meeting
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((s) => {
            const Icon = iconMap[s.icon];
            const t = toneStyles[s.tone];
            return (
              <div
                key={s.label}
                className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--panel-solid)]/40 p-3"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: t.soft }}>
                  <Icon className="h-[18px] w-[18px]" style={{ color: t.color }} />
                </span>
                <div className="leading-tight">
                  <p className="text-xl font-bold tabular-nums">{s.value}</p>
                  <p className="text-[11px] text-faint">{s.label}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

/* ---------------- Revenue Overview ---------------- */

function RevenueOverview({
  series,
  total,
}: {
  series: { label: string; value: number }[];
  total: number;
}) {
  const hasRevenue = series.some((p) => p.value > 0);
  return (
    <Card>
      <CardHeader
        title="Revenue Overview"
        action={
          <span className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted">
            Last 6 weeks
          </span>
        }
      />
      {hasRevenue ? (
        <>
          <p className="-mt-1 mb-1 text-2xl font-bold tabular-nums">${total.toLocaleString()}</p>
          <p className="mb-2 text-xs text-faint">Won across all closed deals</p>
          <AreaChart data={series} />
        </>
      ) : (
        <p className="py-14 text-center text-sm text-faint">
          No revenue yet — move a deal to Closed Won and it appears here.
        </p>
      )}
    </Card>
  );
}

/* ---------------- Revenue Received (closed deals) ---------------- */

function RevenueReceived({
  rows,
  now,
}: {
  rows: {
    id: string;
    initials: string;
    color: AvatarColor;
    client: string;
    company: string;
    title: string;
    wonAt: string;
    amount: number;
  }[];
  now: Date;
}) {
  return (
    <Card>
      <CardHeader
        title="Revenue Received"
        action={<ViewAll href="/deals" />}
      />
      {rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-faint">No deals won yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-[1.6fr_1fr_auto] gap-x-3 px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
            <span>Client</span>
            <span className="hidden sm:block">Won</span>
            <span className="text-right">Amount</span>
          </div>
          <div className="flex flex-col">
            {rows.slice(0, 5).map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-[1.6fr_1fr_auto] items-center gap-x-3 rounded-xl px-1 py-3 transition-colors hover:bg-[var(--raise)]"
              >
                <div className="flex items-center gap-2.5">
                  <Avatar initials={r.initials} color={r.color} size="sm" />
                  <div className="min-w-0 leading-tight">
                    <p className="truncate text-sm font-medium">{r.client}</p>
                    <p className="truncate text-xs text-faint">{r.title}</p>
                  </div>
                </div>
                <p className="hidden truncate text-xs text-muted sm:block">{relativeDay(r.wonAt, now)}</p>
                <p className="text-right text-sm font-semibold text-green">+${r.amount.toLocaleString()}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

/* ---------------- This Week ---------------- */

function SegmentedBar({ value, total, tone }: { value: number; total: number; tone: Tone }) {
  const t = toneStyles[tone];
  const segs = Math.min(Math.max(total, 1), 40);
  const filled = total > 0 ? Math.round((value / total) * segs) : 0;
  return (
    <div className="flex gap-1">
      {Array.from({ length: segs }, (_, i) => (
        <span
          key={i}
          className="h-2.5 flex-1 rounded-full transition-colors"
          style={{ background: i < filled ? t.color : "var(--border)" }}
        />
      ))}
    </div>
  );
}

function ThisWeek({
  openLeads,
  totalLeads,
  clients,
  totalContacts,
}: {
  openLeads: number;
  totalLeads: number;
  clients: number;
  totalContacts: number;
}) {
  return (
    <Card>
      <CardHeader title="This Week" />
      <div className="space-y-6 pt-1">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-muted">Open Leads</span>
            <span className="text-sm font-semibold">
              {openLeads}/{totalLeads}
            </span>
          </div>
          <SegmentedBar value={openLeads} total={totalLeads} tone="amber" />
          <div className="mt-1.5 flex justify-between text-[11px] text-faint">
            <span>0</span>
            <span>{totalLeads}</span>
          </div>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-muted">Active Clients</span>
            <span className="text-sm font-semibold">
              {clients}/{totalContacts}
            </span>
          </div>
          <SegmentedBar value={clients} total={totalContacts} tone="green" />
          <div className="mt-1.5 flex justify-between text-[11px] text-faint">
            <span>0</span>
            <span>{totalContacts}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ---------------- Connections (leads to follow up) ---------------- */

function Connections({
  items,
}: {
  items: { initials: string; color: AvatarColor; name: string; email: string; company: string }[];
}) {
  return (
    <Card>
      <CardHeader title="Follow-ups" action={<ViewAll href="/leads" />} />
      {items.length === 0 ? (
        <p className="py-10 text-center text-sm text-faint">No open follow-ups.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((c) => (
            <Link
              href="/leads"
              key={c.name}
              className="flex items-center gap-3 rounded-xl px-1 py-2.5 transition-colors hover:bg-[var(--raise)]"
            >
              <Avatar initials={c.initials} color={c.color} />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-sm font-medium">{c.name}</p>
                <p className="truncate text-xs text-faint">{c.email}</p>
              </div>
              <p className="hidden max-w-[150px] truncate text-xs text-muted md:block">{c.company}</p>
              <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------------- Reminders (upcoming meetings) ---------------- */

function Reminders({
  items,
}: {
  items: { id: string; name: string; topic: string; when: string; time: string; status: string }[];
}) {
  const Icon = iconMap.calendar;
  return (
    <Card>
      <CardHeader title="Upcoming Meetings" action={<ViewAll href="/meetings" />} />
      {items.length === 0 ? (
        <p className="py-10 text-center text-sm text-faint">Nothing scheduled.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {items.map((r) => (
            <Link
              href="/meetings"
              key={r.id}
              className="flex items-center gap-3 rounded-xl px-1 py-3 transition-colors hover:bg-[var(--raise)]"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: "var(--accent-soft)" }}>
                <Icon className="h-[18px] w-[18px] text-accent" />
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-sm font-medium">{r.name}</p>
                <p className="truncate text-xs text-faint">{r.topic}</p>
              </div>
              <div className="hidden text-right text-xs sm:block">
                <p className="text-muted">{r.when}</p>
                <p className="font-medium text-accent">{r.time}</p>
              </div>
              <span
                className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
                style={{
                  background: r.status === "Confirmed" ? "var(--green-soft)" : "var(--amber-soft)",
                  color: r.status === "Confirmed" ? "var(--green)" : "var(--amber)",
                }}
              >
                {r.status}
              </span>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------------- Today's Focus ---------------- */

function TodaysFocus({ items }: { items: { icon: string; tone: Tone; title: string; sub: string }[] }) {
  return (
    <Card>
      <CardHeader
        title="Today's Focus"
        icon={<Sparkles className="h-[18px] w-[18px] text-accent" />}
        action={<MoreHorizontal className="h-4 w-4 text-faint" />}
      />
      <div className="flex flex-col gap-1">
        {items.map((f) => {
          const Icon = iconMap[f.icon];
          const t = toneStyles[f.tone];
          return (
            <div key={f.title} className="flex items-center gap-3 rounded-xl px-1 py-2.5 text-left">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl" style={{ background: t.soft }}>
                <Icon className="h-[17px] w-[17px]" style={{ color: t.color }} />
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="text-[13px] font-medium">{f.title}</p>
                <p className="truncate text-xs text-faint">{f.sub}</p>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ---------------- Quick Actions (navigating) ---------------- */

const QUICK_ACTIONS = [
  { icon: "user-plus", label: "Add New Lead", href: "/leads" },
  { icon: "calendar-plus", label: "Schedule Meeting", href: "/meetings" },
  { icon: "phone", label: "View Contacts", href: "/contacts" },
  { icon: "file-text", label: "Compose Email", href: "/inbox" },
  { icon: "headphones", label: "Voice Agents", href: "/voice-agents" },
  { icon: "bar-chart", label: "Reports", href: "/reports" },
];

function QuickActions() {
  return (
    <Card>
      <CardHeader title="Quick Actions" />
      <div className="grid grid-cols-2 gap-2.5">
        {QUICK_ACTIONS.map((a) => {
          const Icon = iconMap[a.icon];
          return (
            <Link
              key={a.label}
              href={a.href}
              className="btn-soft focus-ring flex flex-col items-start gap-2.5 rounded-xl p-3 text-left"
            >
              <span className="grid h-9 w-9 place-items-center rounded-lg" style={{ background: "var(--accent-soft)" }}>
                <Icon className="h-[18px] w-[18px] text-accent" />
              </span>
              <span className="text-[13px] font-medium leading-tight">{a.label}</span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

/* ---------------- Activity Feed ---------------- */

function ActivityFeed({ items }: { items: { icon: string; tone: Tone; text: string; time: string }[] }) {
  return (
    <Card>
      {/* No "View all" here — the feed is derived from several entities and
          has no single destination to send anyone to. */}
      <CardHeader title="Activity Feed" />
      <div className="relative flex flex-col">
        {items.map((a, i) => {
          const Icon = iconMap[a.icon];
          const t = toneStyles[a.tone];
          return (
            <div key={i} className="flex gap-3 pb-4 last:pb-0">
              <div className="flex flex-col items-center">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full" style={{ background: t.soft }}>
                  <Icon className="h-[15px] w-[15px]" style={{ color: t.color }} />
                </span>
                {i < items.length - 1 && <span className="mt-1 w-px flex-1 bg-[var(--border)]" />}
              </div>
              <div className="min-w-0 flex-1 pt-1 leading-tight">
                <p className="text-[13px] font-medium">{a.text}</p>
                <p className="text-xs text-faint">{a.time}</p>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
