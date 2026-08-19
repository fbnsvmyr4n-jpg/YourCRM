import { listMeetings } from "@/server/repos/meetings";
import { listContacts } from "@/server/repos/contacts";
import { getSettings } from "@/server/repos/settings";
import { meetingAnalytics } from "@/server/meeting-analytics";
import { decorateMeeting } from "@/server/decorate-meeting";
import { instantToWallClock } from "@/lib/zoned";
import { withTenantPage } from "@/server/tenant-session";
import MeetingsView from "./MeetingsView";

export const dynamic = "force-dynamic";

export default async function MeetingsPage() {
  const { meetings, analytics, capacity, today } = await withTenantPage(async (q) => {
    const settings = await getSettings(q);
    const rows = await listMeetings(q);
    const contacts = await listContacts(q);
    const people = contacts.map((c) => ({
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      email: c.email,
      info: c.info,
    }));

    // "Today" is today in the BUSINESS's zone, not the server's. Otherwise a
    // meeting booked this evening reads as tomorrow's to anyone east of the
    // machine that rendered the page.
    const nowKey =
      instantToWallClock(new Date().toISOString(), settings.timeZone)?.date ??
      new Date().toISOString().slice(0, 10);
    const [y, mo, d] = nowKey.split("-").map(Number);

    return {
      meetings: rows.map((m) => decorateMeeting(m, people, settings.timeZone, nowKey)),
      analytics: await meetingAnalytics(q),
      capacity: settings.weeklyCapacity,
      today: { year: y, month: mo - 1, day: d },
    };
  });

  return (
    <MeetingsView
      meetings={meetings}
      analytics={analytics}
      capacity={capacity}
      today={today}
      people={meetings.map((m) => ({ name: m.name, company: m.company, email: m.email ?? "" }))}
    />
  );
}
