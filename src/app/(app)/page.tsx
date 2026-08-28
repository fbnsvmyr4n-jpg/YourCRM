import Link from "next/link";
import { ChevronRight, Sparkles } from "lucide-react";
import { Avatar, type AvatarColor } from "@/components/ui/Avatar";
import { AreaChart } from "@/components/ui/AreaChart";
import { Card, CardHeader, ViewAll } from "@/components/ui/Card";
import { FocusMenu, type FocusItem } from "@/components/home/FocusMenu";
import { iconMap, toneStyles, type Tone } from "@/components/ui/tone";
import { activityFeed } from "@/server/feed";
import { reportData } from "@/server/analytics";
import { listContacts } from "@/server/repos/contacts";
import { listDeals } from "@/server/repos/deals";
import { listMeetings } from "@/server/repos/meetings";
import { listMessages, unreadCount } from "@/server/repos/inbox";
import { getSettings } from "@/server/repos/settings";
import { DateTimeBar } from "./DateTimeBar";
import { MobileSection } from "./MobileSection";
import { instantToWallClock } from "@/lib/zoned";
import { currentUser, withTenantPage } from "@/server/tenant-session";

export const dynamic = "force-dynamic";

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
  const me = await currentUser();

  const { contacts, meetingsToday, unread, wonDeals, revenueSeries, feed, report, followUps, upcoming, timeZone } =
    await withTenantPage(async (q) => {
      const settings = await getSettings(q);
      const todayKey =
        instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
        new Date().toISOString().slice(0, 10);

      const contacts = await listContacts(q);
      const deals = await listDeals(q);
      const meetings = await listMeetings(q);
      const report = await reportData(q);

      const people = new Map(
        contacts.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()])
      );

      return {
        contacts,
        // "Today" in the business's zone, not the server's — the same rule the
        // calendar follows, and for the same reason.
        meetingsToday: meetings
          .filter((m) => instantToWallClock(m.scheduledAt, settings.timeZone)?.date === todayKey)
          .map((m) => ({
            time: instantToWallClock(m.scheduledAt, settings.timeZone)?.time ?? "",
            name: m.contactId ? (people.get(m.contactId) ?? "") : "",
          })),
        unread: await unreadCount(q),
        // Won-ness from the recorded fact, so a deal in Delivery still counts.
        wonDeals: deals
          .filter((d) => d.wonAt !== null)
          .map((d) => ({
            id: d.id,
            client: d.contactId ? (people.get(d.contactId) ?? "") : "",
            title: d.title,
            wonAt: d.wonAt!,
            amountCents: d.valueCents,
          })),
        // Labelled points, so the chart's axis is derived from real weeks
        // rather than from array positions.
        revenueSeries: report.weekly.map((w) => ({
          label: new Date(w.weekStart).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
          }),
          value: Math.round(w.wonCents / 100),
        })),
        // Follow-ups: people with a deal still in play. That IS what a lead is
        // now, so the card no longer needs a separate table to read.
        followUps: contacts
          .filter((c) => c.hasOpenDeal)
          .slice(0, 3)
          .map((c) => ({
            initials:
              ((c.firstName[0] ?? "") + (c.lastName[0] ?? "")).toUpperCase() || "—",
            color: "amber" as AvatarColor,
            name: `${c.firstName} ${c.lastName}`.trim(),
            email: c.email ?? "",
            company: c.info ?? "",
          })),
        upcoming: meetings
          .filter((m) => Date.parse(m.scheduledAt) >= Date.now() && m.outcome === "scheduled")
          .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))
          .slice(0, 4)
          .map((m) => {
            const w = instantToWallClock(m.scheduledAt, settings.timeZone);
            return {
              id: m.id,
              name: m.contactId ? (people.get(m.contactId) ?? "") : "",
              topic: m.topic || "Meeting",
              when: w?.date === todayKey ? "Today" : (w?.date ?? ""),
              time: w?.time ?? "",
              // Derived from the outcome, never stored alongside it.
              status: m.outcome === "scheduled" ? "Pending" : "Confirmed",
            };
          }),
        feed: await activityFeed(q),
        report,
        // Read so the unread panel has a first sender to name.
        firstUnread: (await listMessages(q, "unread"))[0] ?? null,
        // The business's own zone, so the date on screen counts the same day
        // the meetings below it are filtered by.
        timeZone: settings.timeZone || "UTC",
      };
    });

  const now = new Date();
  /*
     Formatted in the BUSINESS's zone, not the server's.

     This was `toLocaleDateString("en-US", …)` with no `timeZone`, which on
     Vercel means UTC. "Meetings Today" a few pixels away was already filtered
     by the business zone, so at 01:00 in Johannesburg the page printed
     yesterday's date beside a count of today's meetings.
  */
  const weekdayLabel = now.toLocaleDateString("en-GB", { weekday: "long", timeZone });
  const dateLabel = now.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  });

  // ---- derived, real numbers ----
  // A client is somebody who bought something and a lead is somebody with an
  // open deal. Both come from the deals underneath rather than a stored label
  // that could disagree with them.
  const clientCount = report.contacts.clients;
  const openLeadCount = report.contacts.leads;

  const heroStats = [
    { icon: "user-plus", tone: "blue" as Tone, label: "Contacts", value: contacts.length },
    { icon: "bar-chart", tone: "amber" as Tone, label: "Open Leads", value: openLeadCount },
    { icon: "calendar", tone: "purple" as Tone, label: "Meetings Today", value: meetingsToday.length },
    { icon: "message", tone: "green" as Tone, label: "Unread", value: unread },
  ];

  // Real money from real records: won deals carry the value the user entered
  // and the date they actually closed.
  const revenueRows = wonDeals.map((d) => ({
    id: d.id,
    // Initials are derived, not stored — a second copy of somebody's name is
    // a second thing to keep in step.
    initials:
      d.client
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0])
        .join("")
        .toUpperCase() || "—",
    color: "blue" as AvatarColor,
    client: d.client,
    company: "",
    title: d.title,
    wonAt: d.wonAt,
    amount: Math.round(d.amountCents / 100),
  }));
  const revenueTotal = Math.round(report.revenue.wonCents / 100);

  // Deals actually won in the last seven days — the week the panel reports on.
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const wonThisWeek = wonDeals.filter((d) => Date.parse(d.wonAt) >= weekAgo);

  const focus: FocusItem[] = [
    {
      href: "/meetings",
      menuLabel: "Meetings today",
      icon: "calendar",
      tone: "red" as Tone,
      title: `${meetingsToday.length} meeting${meetingsToday.length === 1 ? "" : "s"} today`,
      sub: meetingsToday[0]
        ? `Next: ${meetingsToday[0].time}${meetingsToday[0].name ? ` with ${meetingsToday[0].name}` : ""}`
        : "Nothing on the calendar",
    },
    {
      href: "/leads",
      menuLabel: "Leads needing follow-up",
      icon: "user-plus",
      tone: "amber" as Tone,
      title: `${openLeadCount} lead${openLeadCount === 1 ? "" : "s"} need follow-up`,
      sub: openLeadCount > 0 ? "Open deals waiting on a next step" : "You're all caught up",
    },
    {
      href: "/inbox",
      menuLabel: "Unread messages",
      icon: "message",
      tone: "blue" as Tone,
      title: `${unread} unread message${unread === 1 ? "" : "s"}`,
      sub: unread > 0 ? "Waiting on a reply" : "Inbox zero 🎉",
    },
    {
      href: "/deals",
      menuLabel: "Closed deals",
      icon: "dollar",
      tone: "green" as Tone,
      // Deals closed means *deals*, not leads marked closed — those are
      // different records and conflating them overstated the number.
      title: `${wonDeals.length} deal${wonDeals.length === 1 ? "" : "s"} closed`,
      sub: `$${revenueTotal.toLocaleString()} won · ${clientCount} active client${clientCount === 1 ? "" : "s"}`,
    },
  ];

  // Every row carries the timestamp it was derived from, so the label is a
  // fact and the ordering is real. This used to be four fixed slots with
  // `time: "just now"` written into the lead line as a literal.
  const activity = feed.map((e) => ({
    icon: e.icon,
    tone: e.tone,
    text: e.text,
    time: relativeDay(e.at, now),
  }));

  return (
    <div className="mx-auto max-w-[1500px] animate-fade-up">
      {/*
          On a phone this is one column of ten cards, and the order they arrive
          in is the order they were written for TWO columns — so everything in
          the right rail landed at the bottom. Today's Focus, which is the most
          actionable card on the page and sits top-right on a desktop, was
          seventh.

          `contents` below the breakpoint dissolves the two column wrappers so
          every card becomes a direct child of this flex column and can be
          ordered against the others. From `@min-[820px]` the wrappers come back
          and the desktop grid is untouched.
      */}
      <div className="flex flex-col gap-5 @min-[820px]:grid @min-[820px]:grid-cols-[minmax(0,1fr)_346px]">
        {/* ---------------- MAIN COLUMN ----------------
            A container in its own right. Without this the two-up rows below
            would size themselves against `<main>` and split *this* column in
            half regardless of how narrow it is — which is what squeezed the
            revenue chart to 225px on a page that had 920px to give. */}
        <div className="@container contents @min-[820px]:flex @min-[820px]:flex-col @min-[820px]:gap-5">
          <div className="order-1 @min-[820px]:order-none">
            <DateTimeBar timeZone={timeZone} initialWeekday={weekdayLabel} initialDate={dateLabel} />
          </div>

          <div className="order-2 @min-[820px]:order-none">
            <Hero
              greeting={greeting(now.getHours())}
              name={me?.name.split(" ")[0] ?? "there"}
              summary={`You have ${meetingsToday.length} meeting${meetingsToday.length === 1 ? "" : "s"} and ${openLeadCount} follow-up${openLeadCount === 1 ? "" : "s"} today.`}
              stats={heroStats}
            />
          </div>

          <div className="order-5 @min-[820px]:order-none">
            <MobileSection
              title="Revenue"
              hint={`$${revenueTotal.toLocaleString()} won · last 6 weeks`}
            >
              <div className="grid grid-cols-1 gap-5 @min-[560px]:grid-cols-2">
                <RevenueOverview series={revenueSeries} total={revenueTotal} />
                <RevenueReceived rows={revenueRows} now={now} />
              </div>
            </MobileSection>
          </div>

          <div className="order-6 @min-[820px]:order-none">
            <MobileSection
              title="This week"
              hint={`${wonThisWeek.length} won · ${followUps.length} to follow up`}
            >
              <div className="grid grid-cols-1 gap-5 @min-[560px]:grid-cols-2">
                <ThisWeek
                  wonThisWeek={wonThisWeek.length}
                  wonValue={Math.round(
                    wonThisWeek.reduce((sum, d) => sum + d.amountCents, 0) / 100
                  )}
                  needFollowUp={openLeadCount}
                  totalLeads={contacts.length}
                />
                <Connections items={followUps} />
              </div>
            </MobileSection>
          </div>

          {/* Not folded. A fold has to earn its tap: this card is a short list
              with its own heading, so collapsing it hid nothing and added a
              step. Three folds on this page, not four. */}
          <div className="order-7 @min-[820px]:order-none">
            <Reminders items={upcoming} />
          </div>
        </div>

        {/* ---------------- RIGHT RAIL ---------------- */}
        <div className="contents @min-[820px]:flex @min-[820px]:flex-col @min-[820px]:gap-5">
          {/* Third and fourth on a phone, not seventh and eighth. These are the
              two cards that say what to do next; the rest of the page reports
              on what already happened. */}
          <div className="order-3 @min-[820px]:order-none">
            <TodaysFocus items={focus} />
          </div>
          <div className="order-4 @min-[820px]:order-none">
            <QuickActions />
          </div>
          {/* The feed card is taken out of flow in the two-column layout.
              `flex: 1 1 0%` controls how leftover space is *distributed*; it
              does not stop an item contributing its full content height to the
              flex container's *intrinsic* size. So 20 rows still set this
              rail's height and pushed 598px of slack onto the main column —
              the gap moved rather than closed. An absolutely positioned card
              contributes nothing, so the main column decides the height and
              the feed fills exactly what it is given. The `min-h` is what this
              wrapper contributes instead. */}
          <div className="order-8 @min-[820px]:order-none @min-[820px]:relative @min-[820px]:min-h-[300px] @min-[820px]:flex-1">
            <MobileSection title="Activity" hint={`${activity.length} recent`}>
              <ActivityFeed items={activity} />
            </MobileSection>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Hero ---------------- */

function Hero({
  greeting,
  name,
  summary,
  stats,
}: {
  greeting: string;
  name: string;
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
            {/* The date and the clock used to sit here as an eyebrow. They are
                their own panel above this card now — a caption on a greeting is
                not where somebody looks for the time. */}
            <h2 className="text-2xl font-bold tracking-tight sm:text-[27px]">
              {greeting}, {name} 👋
            </h2>
            <p className="mt-1.5 text-sm text-muted">{summary}</p>
          </div>
          {/* Quick Actions, four cards further down this same page, already has
              a Schedule Meeting button. Two routes to one screen inside one
              viewport is a choice the reader has to make for no reason, and on
              a phone they are close enough together to be seen at once.
              Desktop keeps it: there the two sit in different columns, and it
              has not been reported as confusing there. */}
          <Link
            href="/meetings"
            className="btn-accent focus-ring hidden items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold sm:flex"
          >
            Schedule Meeting
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>

        {/*
            Hidden on a phone, because it is the same information twice.

            Three of these four tiles read the SAME variables Today's Focus
            reads a card below — `openLeadCount`, `meetingsToday.length` and
            `unread`. On a desktop the two sit in different columns and the
            repetition is a glance apart; stacked on a phone they are the same
            four numbers, one after the other, and the second copy is the one
            worth keeping: every row there carries a line of context ("Next:
            09:00 with …", "You're all caught up") and links somewhere, where a
            tile is a bare number.

            It also answers the fourth tile. "Contacts" was a raw row count —
            the least useful figure on the page, since it only ever goes up.
            What replaces it on a phone is Today's Focus's own fourth row:
            deals closed, with the money won and the number of active clients.
        */}
        <div className="mt-5 hidden grid-cols-2 gap-3 sm:grid @min-[520px]:grid-cols-4">
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
          <AreaChart data={series} height={230} />
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
          <div className="grid grid-cols-[minmax(0,2.2fr)_minmax(0,0.9fr)_auto] gap-x-3 px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
            <span>Client</span>
            <span className="hidden sm:block">Won</span>
            <span className="text-right">Amount</span>
          </div>
          <div className="flex flex-col">
            {rows.slice(0, 5).map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-[minmax(0,2.2fr)_minmax(0,0.9fr)_auto] items-center gap-x-3 rounded-xl px-1 py-3 transition-colors hover:bg-[var(--raise)]"
              >
                {/* `min-w-0` on the grid item itself: the inner block already
                    had it, but this flex wrapper was still contributing the
                    untruncated title to the track's automatic minimum, which
                    inflated column one to 200px in a 228px row. */}
                <div className="flex min-w-0 items-center gap-2.5">
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

/**
 * Closed-won against still-open, for the week.
 *
 * Replaces two unrelated progress bars (open leads, active clients) that never
 * answered the only question this panel should: how did the week actually go?
 * The ratio at the foot is the headline — everything above it is the working.
 */
/**
 * Two facts about the week, deliberately kept apart.
 *
 * This card used to show a "Win ratio" of
 * `wonThisWeek ÷ (wonThisWeek + stillOpen)` — **deals divided by deals plus
 * leads**. It read "8 won of 14" while the entire store held ten deals,
 * contradicted the Reports page's 100% with no way to reconcile the two, and
 * fell every time a lead was added, so the metric punished prospecting. The
 * local was even named `decided`, borrowed from the meetings analytics where
 * that word has a precise and correct meaning: the name was copied, the
 * semantics were not.
 *
 * The underlying error was mixing a **flow** (deals closed during the week)
 * with a **stock** (leads awaiting follow-up right now). Those share no
 * denominator, so they get separate rows and separate units, and no ratio is
 * drawn between them. The follow-up bar measures against all leads, which is a
 * proportion that actually exists.
 */
function ThisWeek({
  wonThisWeek,
  wonValue,
  needFollowUp,
  totalLeads,
}: {
  wonThisWeek: number;
  wonValue: number;
  needFollowUp: number;
  totalLeads: number;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader title="This Week" />

      <div className="pt-1">
        <p className="text-xs text-faint">Closed won · last 7 days</p>
        <p className="mt-1 text-3xl font-bold tabular-nums text-green">
          ${wonValue.toLocaleString()}
        </p>
        <p className="mt-1 text-xs text-faint">
          {wonThisWeek === 0
            ? "No deals closed yet this week"
            : `across ${wonThisWeek} deal${wonThisWeek === 1 ? "" : "s"}`}
        </p>
      </div>

      <div className="mt-auto border-t border-[var(--border)] pt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm text-muted">Leads awaiting follow-up</span>
          <span className="text-sm font-semibold tabular-nums text-amber">
            {needFollowUp}
            {totalLeads > 0 && <span className="text-faint"> of {totalLeads}</span>}
          </span>
        </div>
        <SegmentedBar value={needFollowUp} total={Math.max(totalLeads, 1)} tone="amber" />
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
              className="focus-ring flex items-center gap-3 rounded-xl px-1 py-2.5 transition-colors hover:bg-[var(--raise)]"
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
              className="focus-ring flex items-center gap-3 rounded-xl px-1 py-3 transition-colors hover:bg-[var(--raise)]"
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

/**
 * Each focus is a link to the work it describes, and the ⋯ opens a menu of the
 * same destinations. Reading "4 leads need follow-up" and then having to go
 * and find the Leads page is the slow path this removes.
 */
function TodaysFocus({ items }: { items: FocusItem[] }) {
  return (
    <Card>
      <CardHeader
        title="Today's Focus"
        icon={<Sparkles className="h-[18px] w-[18px] text-accent" />}
        action={<FocusMenu items={items} />}
      />
      <div className="flex flex-col gap-1">
        {items.map((f) => {
          const Icon = iconMap[f.icon];
          const t = toneStyles[f.tone];
          return (
            <Link
              key={f.title}
              href={f.href}
              className="focus-ring group flex items-center gap-3 rounded-xl px-1 py-2.5 text-left transition-colors hover:bg-[var(--raise)]"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl" style={{ background: t.soft }}>
                <Icon className="h-[17px] w-[17px]" style={{ color: t.color }} />
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="text-[13px] font-medium">{f.title}</p>
                <p className="truncate text-xs text-faint">{f.sub}</p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

/* ---------------- Quick Actions (navigating) ---------------- */

/**
 * Three of these carry a query flag rather than pointing at the bare page.
 * The destination reads it on mount and opens the relevant form straight away
 * — landing on /leads and then hunting for "Add Lead" was the slow path.
 */
const QUICK_ACTIONS = [
  { icon: "user-plus", label: "Add New Lead", href: "/leads?new=1" },
  { icon: "calendar-plus", label: "Schedule Meeting", href: "/meetings?schedule=1" },
  { icon: "phone", label: "View Contacts", href: "/contacts" },
  { icon: "file-text", label: "Compose Email", href: "/inbox?compose=1" },
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
    // Last card in the rail, so it absorbs whatever height the main column
    // leaves over — 271px of empty rail sat under here. A feed is the right
    // thing to grow: it was capped at four rows by construction while the
    // store held far more real events.
    //
    // The list scrolls inside the card rather than setting its height. Sizing
    // the card to a fixed number of rows just moved the gap to the other
    // column (12 rows overshot the main column by 147px), and any row count
    // that balances today stops balancing the moment the data changes. This
    // way the feed fills exactly what it is given, in either direction, and
    // the rest of the history is a scroll away.
    <Card className="flex flex-col @min-[820px]:absolute @min-[820px]:inset-0 @min-[820px]:min-h-0">
      {/* No "View all" here — the feed is derived from several entities and
          has no single destination to send anyone to. */}
      <CardHeader title="Activity Feed" />
      {/* The fill-and-scroll behaviour is scoped to the two-column layout,
          which is the only place there is leftover height to hand out. A flex
          item defaults to `min-height: auto` and so refuses to shrink below its
          content — without `min-h-0` the 20 rows set the rail's height and
          pushed 598px of slack onto the main column instead. Single column: no
          stretch, no cap, the list is simply its natural height. */}
      <div className="relative -mx-1 flex flex-col px-1 @min-[820px]:min-h-0 @min-[820px]:flex-1 @min-[820px]:overflow-y-auto">
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
